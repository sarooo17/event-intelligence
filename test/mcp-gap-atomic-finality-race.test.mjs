import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TemporalDeadlineScheduler } from '../scripts/lib/temporal-deadline-scheduler.mjs';

test('atomic finality fence rejects an MCP gap committed after CEP reads its snapshot', {
  timeout:30000,
},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-gap-atomic-race-'));
  let store;
  try{
    store=new PersistentEventStore(dir);
    await store.init();
    const t0=Date.now()+3600000;
    let now=new Date(t0);
    const engine=new CompositeTriggerEngine(store,null,()=>now);
    const triggerId='gap-race-timer';
    await engine.register({
      triggerId,version:'1',conditionOnly:true,
      clauses:[
        {id:'a',event:'job.started',serverId:'upstream',arguments:{},where:[]},
        {id:'b',event:'job.failed',serverId:'upstream',arguments:{},where:[]},
      ],
      pattern:{
        version:'2',root:{
          kind:'notFollowedBy',id:'race-neg',
          child:{kind:'event',ref:'a'},
          forbidden:{kind:'event',ref:'b'},withinMs:1000,
        },
        partitionBy:[],selection:{
          overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:10,
        },
        execution:{
          maxCandidates:16,maxSemanticEvaluations:0,maxBufferedEvents:32,
        },
      },
      withinMs:60000,
    });
    const first=await engine.ingest({
      traceId:'gap-race:a',sourceEventId:'gap-race:a',
      name:'job.started',serverId:'upstream',provider:'mcp',
      occurredAt:new Date(t0).toISOString(),subscriptionArguments:{},
      data:{},
    });
    assert.equal(first.some(x=>x.matched),false);
    assert.equal(store.listTemporalDeadlines({
      triggerId,status:'pending',
    }).length,1);

    const original=store.getMcpGapStateAndSnapshot.bind(store);
    let announce;
    const observed=new Promise(resolve=>{announce=resolve});
    let release;
    const proceed=new Promise(resolve=>{release=resolve});
    let captured=false;
    store.getMcpGapStateAndSnapshot=async()=>{
      const evidence=original();
      if(!captured){
        captured=true;
        announce();
        await proceed;
      }
      return evidence;
    };
    const scheduler=new TemporalDeadlineScheduler({
      store,
      compositeEventConsumer:new CompositeEventConsumer({
        store,triggerEngine:engine,wakeCoordinators:new Map(),
      }),
      now:()=>now,
    });
    now=new Date(t0+1000);
    const running=scheduler.runDue();
    await observed;
    const gap=await store.putMcpClientState({
      connectionId:'source',serverId:'upstream',eventName:'job.failed',
      arguments:{},cursor:'gap:1',truncated:true,
      deliveryMode:'poll',
    });
    assert.equal(gap.gapUnresolved,true);
    release();
    const result=await running;
    assert.deepEqual(result.map(x=>x.status),['deferred']);
    assert.equal(store.listTriggerMatches(triggerId)
      .filter(x=>x.status==='matched').length,0,
      'stale complete snapshot must not commit a false negative');
    assert.equal(store.listTemporalDeadlines({
      triggerId,status:'pending',
    }).length,1,'retry path persists after the fenced stale commit');

    await store.putMcpClientState({
      ...gap,gapReconciled:true,
      reconciliationEvidenceId:'host-verified-replay-atomic-race',
      truncated:false,
    });
    const fixed=await scheduler.runDue();
    assert.deepEqual(fixed.map(x=>x.status),['fired']);
    assert.equal(store.listTriggerMatches(triggerId)
      .filter(x=>x.status==='matched').length,1);
    assert.deepEqual(await scheduler.runDue(),[]);
  }finally{
    await store?.close();
    await rm(dir,{recursive:true,force:true});
  }
});


test('two stale MCP gap snapshots retain a due retry through reconciliation', {
  timeout:30000,
},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-gap-double-stale-'));
  let store;
  try{
    store=new PersistentEventStore(dir);
    await store.init();
    const t0=Date.now()+3600000;
    let now=new Date(t0);
    const triggerId='gap-double-stale-timer';
    const engine=new CompositeTriggerEngine(store,null,()=>now);
    await engine.register({
      triggerId,version:'1',conditionOnly:true,
      clauses:[
        {id:'a',event:'job.started',serverId:'upstream',arguments:{},where:[]},
        {id:'b',event:'job.failed',serverId:'upstream',arguments:{},where:[]},
      ],
      pattern:{
        version:'2',root:{
          kind:'notFollowedBy',id:'double-stale-neg',
          child:{kind:'event',ref:'a'},
          forbidden:{kind:'event',ref:'b'},withinMs:1000,
        },
        partitionBy:[],selection:{
          overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:10,
        },
        execution:{
          maxCandidates:16,maxSemanticEvaluations:0,maxBufferedEvents:32,
        },
      },
      withinMs:60000,
    });
    await engine.ingest({
      traceId:'gap-double:a',sourceEventId:'gap-double:a',
      name:'job.started',serverId:'upstream',provider:'mcp',
      occurredAt:new Date(t0).toISOString(),subscriptionArguments:{},
      data:{},
    });
    assert.equal(store.listTemporalDeadlines({
      triggerId,status:'pending',
    }).length,1);

    // First optimistic check loses to an unrelated gap; the bounded retry
    // then loses to a relevant gap. This forces the exhausted-retry branch.
    const original=store.getMcpGapStateAndSnapshot.bind(store);
    let snapshots=0;
    store.getMcpGapStateAndSnapshot=async()=>{
      const evidence=original();
      snapshots++;
      if(snapshots===1){
        await store.putMcpClientState({
          connectionId:'unrelated',serverId:'other',
          eventName:'other.event',arguments:{},
          cursor:'unrelated:1',truncated:true,deliveryMode:'poll',
        });
      }else if(snapshots===2){
        await store.putMcpClientState({
          connectionId:'source',serverId:'upstream',
          eventName:'job.failed',arguments:{},
          cursor:'gap:2',truncated:true,deliveryMode:'poll',
        });
      }
      return evidence;
    };
    now=new Date(t0+1000);
    const scheduler=new TemporalDeadlineScheduler({
      store,
      compositeEventConsumer:new CompositeEventConsumer({
        store,triggerEngine:engine,wakeCoordinators:new Map(),
      }),
      now:()=>now,
    });
    const failed=await scheduler.runDue();
    assert.equal(snapshots,2,'exercise both stale snapshot append failures');
    assert.deepEqual(failed.map(x=>x.status),['deferred']);
    assert.equal(store.listTriggerMatches(triggerId)
      .filter(x=>x.status==='matched').length,0);
    assert.equal(store.listTemporalDeadlines({
      triggerId,status:'pending',
    }).length,1,
    'retry is restored after the second snapshot invalidated deadline reconciliation');

    store.getMcpGapStateAndSnapshot=original;
    assert.deepEqual((await scheduler.runDue()).map(x=>x.status),['deferred'],
      'unresolved source gap must not finalize the negative');
    assert.equal(store.listTriggerMatches(triggerId)
      .filter(x=>x.status==='matched').length,0);
    assert.equal(store.listTemporalDeadlines({
      triggerId,status:'pending',
    }).length,1);

    const gap=store.listMcpClientStates().find(x=>
      x.connectionId==='source' && x.eventName==='job.failed');
    assert.ok(gap?.gapUnresolved);
    await store.putMcpClientState({
      ...gap,gapReconciled:true,
      reconciliationEvidenceId:'host-verified-replay-double-stale',
      truncated:false,
    });
    const recovered=await scheduler.runDue();
    assert.deepEqual(recovered.map(x=>x.status),['fired']);
    assert.equal(store.listTriggerMatches(triggerId)
      .filter(x=>x.status==='matched').length,1);
    assert.deepEqual(await scheduler.runDue(),[],
      'reconciled negative is emitted exactly once');
  }finally{
    await store?.close();
    await rm(dir,{recursive:true,force:true});
  }
});
