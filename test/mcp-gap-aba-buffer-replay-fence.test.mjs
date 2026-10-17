import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TemporalDeadlineScheduler } from '../scripts/lib/temporal-deadline-scheduler.mjs';

for (const scenario of ['ABA gap and reconciliation', 'buffer-only replay']) {
  test('negative finality is fenced against concurrent ' + scenario, {
    timeout: 30000,
  }, async () => {
    const dir=await mkdtemp(path.join(os.tmpdir(), 'ei-gap-replay-fence-'));
    let store;
    try {
      store=new PersistentEventStore(dir);
      await store.init();
      const t0=Date.now()+3600000;
      let now=new Date(t0);
      const engine=new CompositeTriggerEngine(store,null,()=>now);
      const triggerId='replay-fence-'+scenario.replaceAll(' ','-');
      await engine.register({
        triggerId,version:'1',conditionOnly:true,
        clauses:[
          {id:'a',event:'job.started',serverId:'upstream',arguments:{},where:[]},
          {id:'b',event:'job.failed',serverId:'upstream',arguments:{},where:[]},
        ],
        pattern:{
          version:'2',
          root:{
            kind:'notFollowedBy',id:'fenced-neg',
            child:{kind:'event',ref:'a'},
            forbidden:{kind:'event',ref:'b'},withinMs:1000,
          },
          partitionBy:[],
          selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:10},
          execution:{maxCandidates:32,maxSemanticEvaluations:0,maxBufferedEvents:64},
        },
        withinMs:60000,
      });
      const source={
        connectionId:'source',serverId:'upstream',eventName:'job.failed',
        arguments:{},deliveryMode:'poll',
      };
      // Crucial: the source already exists in the initial COMPLETE snapshot.
      const complete=await store.putMcpClientState({...source,truncated:false});
      const initialRevision=complete.completenessRevision;
      const event=(name,id,time)=>({
        traceId:'replay:'+id,sourceEventId:'replay:'+id,
        name,serverId:'upstream',provider:'mcp',
        occurredAt:new Date(time).toISOString(),subscriptionArguments:{},
        data:{},
      });
      await engine.ingest(event('job.started','a',t0));
      assert.equal(store.listTemporalDeadlines({
        triggerId,status:'pending',
      }).length,1);

      let injected=0;
      const original=store.getMcpGapStateAndSnapshot.bind(store);
      store.getMcpGapStateAndSnapshot=async()=>{
        const previous=original();
        if (injected++ === 0) {
          if(scenario==='ABA gap and reconciliation') {
            const gap=await store.putMcpClientState({
              ...source,cursor:'gap:1',truncated:true,
            });
            assert.equal(gap.gapUnresolved,true);
          }
          // Host replay changes the durable partial buffer while this timer
          // is still evaluating the pre-replay anchor-only buffer.
          await engine.ingest(event('job.failed','b',t0+500));
          if(scenario==='ABA gap and reconciliation') {
            const gap=store.getMcpClientState('source','job.failed',{});
            const repaired=await store.putMcpClientState({
              ...gap,truncated:false,gapReconciled:true,
              expectedCompletenessRevision:gap.completenessRevision,
              reconciliationEvidenceId:'verified-replay-aba',
            });
            assert.equal(repaired.gapUnresolved,false);
            assert.ok(repaired.completenessRevision>initialRevision);
            assert.notEqual(previous.snapshot, original().snapshot,
              'an open/close cycle must not be ABA-equal');
          } else {
            assert.equal(previous.snapshot,original().snapshot,
              'the buffer fence must work without a gap-state change');
          }
        }
        return previous;
      };

      now=new Date(t0+1000);
      const scheduler=new TemporalDeadlineScheduler({
        store,
        compositeEventConsumer:new CompositeEventConsumer({
          store,triggerEngine:engine,wakeCoordinators:new Map(),
        }),
        now:()=>now,
      });
      await scheduler.runDue();
      store.getMcpGapStateAndSnapshot=original;
      assert.ok(injected>=1,'the in-flight timer must evaluate a stale snapshot');
      assert.equal(store.listTriggerMatches(triggerId)
        .filter(x=>x.patternState?.role==='match'&&x.status==='matched')
        .length,0,
        'replayed forbidden event must prevent false-certain negative');
      assert.ok(store.listTriggerMatches(triggerId)
        .some(x=>x.patternState?.role==='buffer'&&
          x.sourceEvents.some(e=>e.sourceEventId==='replay:b')),
        'the newest durable buffer includes the replayed forbidden event');
      await scheduler.runDue();
      assert.equal(store.listTriggerMatches(triggerId)
        .filter(x=>x.patternState?.role==='match'&&x.status==='matched')
        .length,0,
        'no stale retry can emit a false negative');
    } finally {
      await store?.close();
      await rm(dir,{recursive:true,force:true});
    }
  });
}

test('MCP completeness revision survives physical restart and ignores caller forgery',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-gap-revision-'));
  let store;
  try {
    store=new PersistentEventStore(dir);
    await store.init();
    const row={
      connectionId:'c',serverId:'s',eventName:'e',arguments:{},
      deliveryMode:'poll',truncated:false,
    };
    const first=await store.putMcpClientState({...row,completenessRevision:9000});
    assert.equal(first.completenessRevision,1);
    const snapshot=store.getMcpGapStateAndSnapshot().snapshot;
    const firstGap=await store.putMcpClientState({...row,truncated:true});
    const reconciled=await store.putMcpClientState({
      ...row,truncated:false,gapReconciled:true,
      expectedCompletenessRevision:firstGap.completenessRevision,
      reconciliationEvidenceId:'verified-replay',
    });
    assert.equal(reconciled.completenessRevision,3);
    assert.notEqual(snapshot,store.getMcpGapStateAndSnapshot().snapshot);
    await store.close();
    store=new PersistentEventStore(dir);
    await store.init();
    const after=await store.putMcpClientState({...row,truncated:false});
    assert.equal(after.completenessRevision,4);
  }finally{
    await store?.close();
    await rm(dir,{recursive:true,force:true});
  }
});
