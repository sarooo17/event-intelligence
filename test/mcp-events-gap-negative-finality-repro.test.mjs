import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { PatternAstV2DefinitionSchema } from '../dist/src/intelligenceProtocol/index.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TemporalDeadlineScheduler } from '../scripts/lib/temporal-deadline-scheduler.mjs';

// This is an intentionally GREEN, pre-fix CHARACTERIZATION test. It does
// not assert that gap-aware finality is implemented. It proves that current
// timer-driven negative finality ignores a persisted provider gap.
// The follow-up safety PR must INVERT the gap-before-finality assertions.
const base = Date.UTC(2026, 9, 16, 12, 0, 0);
const negativeWindowMs = 4000;
const triggerId = 'sep3415-gap-repro';

const pattern = PatternAstV2DefinitionSchema.parse({
  version:'2',
  root:{
    kind:'notFollowedBy',id:'negative-gap-witness',
    child:{kind:'event',ref:'anchor'},
    forbidden:{kind:'event',ref:'forbidden'},
    withinMs:negativeWindowMs,
  },
  partitionBy:[],
  selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:10},
  execution:{maxCandidates:32,maxSemanticEvaluations:0,maxBufferedEvents:64},
});
function event(name,at,seed){
  return {
    traceId:'gap-repro:'+seed,
    sourceEventId:'gap-repro:'+seed,
    name,serverId:'upstream',provider:'mcp',
    occurredAt:new Date(at).toISOString(),
    subscriptionArguments:{},data:{},
  };
}
async function characterize({gap='none',restart=false}={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-gap-repro-'));
  let store;
  let now=new Date(base);
  const gapAt=new Date(base+negativeWindowMs-1).toISOString();
  try{
    store=new PersistentEventStore(dir);
    await store.init();
    let engine=new CompositeTriggerEngine(store,null,()=>now);
    await engine.register({
      triggerId,version:'1',conditionOnly:true,
      clauses:[
        {id:'anchor',event:'job.started',serverId:'upstream',arguments:{},where:[]},
        {id:'forbidden',event:'job.failed',serverId:'upstream',arguments:{},where:[]},
      ],
      pattern,withinMs:60000,
    });
    const initial=await engine.ingest(event('job.started',base,'a'));
    assert.equal(initial.some(x=>x.matched),false);
    assert.equal(store.listTemporalDeadlines({triggerId,status:'pending'}).length,1);

    // Real MCP client state: both JSONL and PostgreSQL persist this shape.
    if(gap!=='none'&&gap!=='late'){
      await store.putMcpClientState({
        connectionId:'upstream-conn',
        serverId:gap==='unrelated'?'other-upstream':'upstream',
        eventName:gap==='unrelated'?'other.event':'job.failed',
        arguments:{},cursor:'gap:after:previous',
        subscriptionId:'gap-sensitive-sub',
        deliveryMode:gap==='push'?'push':gap==='webhook'?'webhook':'poll',
        truncated:true,lastEventAt:gapAt,
      });
    }
    if(restart){
      await store.close();
      store=new PersistentEventStore(dir);
      await store.init();
      engine=new CompositeTriggerEngine(store,null,()=>now);
      if(gap!=='none'&&gap!=='late'){
        assert.equal(
          store.getMcpClientState('upstream-conn',
            gap==='unrelated'?'other.event':'job.failed').truncated,
          true,'a provider gap must survive durable store reopen');
      }
    }
    now=new Date(base+negativeWindowMs);
    const scheduler=new TemporalDeadlineScheduler({
      store,
      compositeEventConsumer:new CompositeEventConsumer({
        store,triggerEngine:engine,wakeCoordinators:new Map(),
      }),
      now:()=>now,
    });
    const due=await scheduler.runDue();
    const matches=store.listTriggerMatches(triggerId)
      .filter(x=>x.patternState?.role==='match'&&x.status==='matched');
    if(gap==='late'){
      await store.putMcpClientState({
        connectionId:'upstream-conn',serverId:'upstream',
        eventName:'job.failed',arguments:{},cursor:'gap:late',
        subscriptionId:'gap-sensitive-sub',deliveryMode:'poll',
        truncated:true,lastEventAt:gapAt,
      });
    }
    const saved=store.getMcpClientState('upstream-conn',
      gap==='unrelated'?'other.event':'job.failed');
    return {
      due:due.map(x=>x.status),
      matched:matches.length,
      sourceGap:saved?.truncated===true,
      gapSource:saved?.eventName??null,
      fired:store.listTemporalDeadlines({triggerId,status:'fired'}).length,
      pending:store.listTemporalDeadlines({triggerId,status:'pending'}).length,
    };
  }finally{
    await store?.close();
    await rm(dir,{recursive:true,force:true});
  }
}

test('baseline clean interval finalizes a bounded negative deadline',async()=>{
  const result=await characterize();
  assert.equal(result.sourceGap,false);
  assert.equal(result.matched,1);
  assert.equal(result.fired,1);
});

test('REPRO: poll/push/webhook provider gaps currently do not block negative finality',async()=>{
  for(const gap of ['poll','push','webhook']){
    const result=await characterize({gap});
    assert.equal(result.sourceGap,true);
    assert.equal(result.gapSource,'job.failed');
    assert.equal(result.matched,1,
      'KNOWN UNSAFE BASELINE: a persisted missing-source gap is ignored');
    assert.equal(result.fired,1);
    assert.deepEqual(result.due,['fired']);
  }
});

test('REPRO: restart preserves the gap record but still finalizes a negative',async()=>{
  const result=await characterize({gap:'poll',restart:true});
  assert.equal(result.sourceGap,true);
  assert.equal(result.matched,1,
    'KNOWN UNSAFE BASELINE: durable gap and timer finality disagree after restart');
});

test('unrelated source gap and gap learned after finality are different cases',async()=>{
  const other=await characterize({gap:'unrelated'});
  const late=await characterize({gap:'late'});
  assert.equal(other.sourceGap,true);
  assert.equal(other.gapSource,'other.event');
  assert.equal(other.matched,1,
    'unrelated source gap must not globally suspend independent trigger');
  assert.equal(late.sourceGap,true);
  assert.equal(late.matched,1,
    'a gap learned after finality cannot retroactively prevent an effect');
});

test('two independent JSONL scope stores do not share gap state',async()=>{
  const [gap,clean]=await Promise.all([
    characterize({gap:'poll',restart:true}),
    characterize({gap:'none',restart:true}),
  ]);
  assert.equal(gap.sourceGap,true);
  assert.equal(clean.sourceGap,false);
  assert.equal(clean.matched,1);
});
