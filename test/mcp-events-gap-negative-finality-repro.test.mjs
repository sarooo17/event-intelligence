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

// Former pre-fix witness inverted: relevant provider gaps must defer
// negative deadlines, including after durable reopen.
// Keep the fixture's event-time horizon strictly AFTER the store's real
// updatedAt clock; otherwise a gap written now looks discovered too late.
const base = Date.now() + 60 * 60 * 1000;
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
    if(gap!=='none'){
      await store.putMcpClientState({
        connectionId:'upstream-conn',
        serverId:gap==='unrelated'||gap==='other_server'?'other-upstream':'upstream',
        eventName:gap==='unrelated'||gap==='other_event'?'other.event':'job.failed',
        arguments:gap==='other_args'?{tenant:'another'}:{},cursor:'gap:after:previous',
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
      if(gap!=='none'){
        assert.equal(
          store.getMcpClientState('upstream-conn',
            gap==='unrelated'||gap==='other_event'?'other.event':'job.failed',
            gap==='other_args'?{tenant:'another'}:{}).truncated,
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
    const saved=store.getMcpClientState('upstream-conn',
      gap==='unrelated'||gap==='other_event'?'other.event':'job.failed',
      gap==='other_args'?{tenant:'another'}:{});
    return {
      due:due.map(x=>x.status),
      matched:matches.length,
      sourceGap:saved?.truncated===true,
      gapSource:saved?.eventName??null,
      gapServer:saved?.serverId??null,
      gapArguments:saved?.arguments??null,
      gapUpdatedAt:saved?.updatedAt??null,
      dueAt:new Date(base+negativeWindowMs).toISOString(),
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

test('poll/push/webhook provider gaps block false negative finality',async()=>{
  for(const gap of ['poll','push','webhook']){
    const result=await characterize({gap});
    assert.equal(result.sourceGap,true);
    assert.equal(result.gapSource,'job.failed');
    assert.ok(Date.parse(result.gapUpdatedAt)<Date.parse(result.dueAt),
      'persisted gap discovery must precede the simulated deadline');
    assert.equal(result.matched,0,'missing-source evidence cannot finalize a negative');
    assert.equal(result.fired,0);
    assert.equal(result.pending,1);
    assert.deepEqual(result.due,['deferred']);
  }
});

test('durable reopened gap continues to defer negative finality',async()=>{
  const result=await characterize({gap:'poll',restart:true});
  assert.equal(result.sourceGap,true);
  assert.equal(result.matched,0,
    'durable gap and timer finality must agree after restart');
  assert.equal(result.pending,1);
});

test('unrelated source identity variants must not cause a global suspension',async()=>{
  for(const gap of ['unrelated','other_server','other_event','other_args']) {
    const other=await characterize({gap});
    assert.equal(other.sourceGap,true);
    assert.equal(other.matched,1,
      gap+' must not globally suspend independent source identities');
  }
});

test('two actual scopes under the same JSONL root isolate gap state across reopen',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-gap-scopes-'));
  let root;
  try{
    root=new PersistentEventStore(dir);
    await root.init();
    const a=await root.forScope('tenant-a');
    const b=await root.forScope('tenant-b');
    await a.putMcpClientState({
      connectionId:'same-conn',serverId:'upstream',eventName:'job.failed',
      arguments:{},cursor:'gap:a',deliveryMode:'poll',truncated:true,
    });
    assert.equal(a.getMcpClientState('same-conn','job.failed').truncated,true);
    assert.equal(b.getMcpClientState('same-conn','job.failed'),null);
    await root.close();
    root=new PersistentEventStore(dir);
    await root.init();
    const reopenedA=await root.forScope('tenant-a');
    const reopenedB=await root.forScope('tenant-b');
    assert.equal(reopenedA.getMcpClientState('same-conn','job.failed').truncated,true);
    assert.equal(reopenedB.getMcpClientState('same-conn','job.failed'),null);
  }finally{
    await root?.close();
    await rm(dir,{recursive:true,force:true});
  }
});
