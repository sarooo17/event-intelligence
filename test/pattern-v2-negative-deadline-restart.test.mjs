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

const triggerId = 'cep-negative-durable-restart';
const withinMs = 5000;
const latenessMs = 0;
const pattern = PatternAstV2DefinitionSchema.parse({
  version: '2',
  root: {
    kind: 'notFollowedBy',
    id: 'no-following-error',
    child: { kind: 'event', ref: 'a' },
    forbidden: { kind: 'event', ref: 'b' },
    withinMs,
  },
  partitionBy: [],
  selection: {overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:10},
  execution:{maxCandidates:32,maxSemanticEvaluations:0,maxBufferedEvents:64},
});
const trigger = {
  triggerId, version:'1', conditionOnly:true,
  clauses:[
    {id:'a',event:'job.started',arguments:{},where:[]},
    {id:'b',event:'job.failed',arguments:{},where:[]},
  ],
  pattern, withinMs:60000,
};

function event(ref,seed,ms) {
  return {
    traceId:'negative-restart:'+seed+':'+ref,
    sourceEventId:'negative-restart:'+seed+':'+ref,
    name:ref==='a'?'job.started':'job.failed',
    provider:'synthetic',serverId:'reference',
    occurredAt:new Date(ms).toISOString(),subscriptionArguments:{},
    data:{seed,source:ref},
  };
}
function summary(store) {
  return {
    matched: store.listTriggerMatches(triggerId)
      .filter(x=>x.patternState?.role==='match' &&
        x.status==='matched')
      .map(x=>({
        evidence:x.sourceEvents.map(e=>e.sourceEventId),
        completedAt:x.patternState.completedAt,
      }))
      .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    deadlines:store.listTemporalDeadlines({triggerId})
      .map(x=>({dueAt:x.dueAt,status:x.status})).sort((a,b)=>
        a.dueAt.localeCompare(b.dueAt)),
  };
}

async function execute(seed,blocked,doRestart){
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-neg-restart-oracle-'));
  let store;
  const t0=Date.UTC(2026,9,16,8,0,0)+seed*100000;
  let now=new Date(t0);
  const anchor=event('a',seed,t0);
  const forbidden=event('b',seed,t0+withinMs-1);
  try {
    store=new PersistentEventStore(dir);
    await store.init();
    let engine=new CompositeTriggerEngine(store,null,()=>now);
    await engine.register(trigger);

    const first=await engine.ingest(anchor);
    assert.ok(first.length>0,'source must be consumed');
    assert.equal(first.some(x=>x.matched),false);
    const initial=store.listTemporalDeadlines({triggerId,status:'pending'});
    assert.equal(initial.length,1,
      'initial anchor must create one pending notFollowedBy deadline');
    assert.equal(initial[0].dueAt,new Date(t0+withinMs+latenessMs).toISOString());

    if(doRestart){
      await store.close();
      store=new PersistentEventStore(dir);
      await store.init();
      engine=new CompositeTriggerEngine(store,null,()=>now);
      assert.equal(store.listTemporalDeadlines({
        triggerId,status:'pending'}).length,1,
        'physical process-like reopen must retain pending negative deadline');
    }
    now=new Date(t0+withinMs-1);
    if(blocked) {
      const pre=await engine.ingest(forbidden);
      assert.equal(pre.some(x=>x.matched),false,
        'forbidden at deadline-1ms must cancel negative match');
    }
    const consumer=new CompositeEventConsumer({
      store,triggerEngine:engine,wakeCoordinators:new Map(),
    });
    const scheduler=new TemporalDeadlineScheduler({
      store,compositeEventConsumer:consumer,now:()=>now,
    });
    const early=await scheduler.runDue();
    assert.deepEqual(early,[],
      'scheduler must not finish negative match one millisecond early');
    now=new Date(t0+withinMs);
    await scheduler.runDue();
    const actual=summary(store);

    // Replay on the same clock and across another physical store reopen:
    // no additional match, and no change to authoritative deadline state.
    await scheduler.runDue();
    assert.deepEqual(summary(store),actual,
      'same-clock second timer pass must not duplicate negative evidence');
    assert.equal(await store.verifyAudit(),true);
    await store.close();
    store=new PersistentEventStore(dir);
    await store.init();
    assert.deepEqual(summary(store),actual,
      'restored deadline/match evidence must equal pre-restart output');
    return actual;
  } finally {
    try {await store?.close();}finally{
      await rm(dir,{recursive:true,force:true});
    }
  }
}

test('negative CEP deadline is restart-equivalent for both blocked and clean event-time histories', {
  timeout:60000,
},async()=>{
  for(let seed=1;seed<=12;seed++){
    for(const blocked of [false,true]){
      const baseline=await execute(seed,blocked,false);
      const restarted=await execute(seed,blocked,true);
      assert.deepEqual(restarted,baseline,
        'seed='+seed+' blocked='+blocked+' restart changed durable semantics');
      assert.equal(baseline.matched.length,blocked?0:1,
        'negative finality should reflect forbidden occurrence at deadline-1');
      if(!blocked){
        assert.deepEqual(baseline.matched[0].evidence,[
          'negative-restart:'+seed+':a',
        ]);
      }
    }
  }
});
