import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import { McpEventsClientManager } from '../scripts/lib/mcp-events-client.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TemporalDeadlineScheduler } from '../scripts/lib/temporal-deadline-scheduler.mjs';

const t0=Date.now()+60_000*60;
const roots={
  notPresent:{kind:'notPresent',ref:'b',child:{kind:'event',ref:'a'}},
  notNext:{kind:'notNext',child:{kind:'event',ref:'a'},
    forbidden:{kind:'event',ref:'b'}},
  notFollowedBy:{kind:'notFollowedBy',id:'gap:no-b',
    child:{kind:'event',ref:'a'},forbidden:{kind:'event',ref:'b'},
    withinMs:1000},
  absence:{kind:'absence',id:'gap:absence',ref:'b',afterRef:'a',
    child:{kind:'event',ref:'a'},forMs:1000},
};

test('all negative deadline variants defer before verified replay and recover after explicit host acknowledgment', {timeout:60000},async()=>{
  for(const [kind,root] of Object.entries(roots)){
    const dir=await mkdtemp(path.join(os.tmpdir(),'ei-gap-durable-recover-'));
    let store;
    let manager;
    try{
      store=new PersistentEventStore(dir);
      await store.init();
      let now=new Date(t0);
      const engine=new CompositeTriggerEngine(store,null,()=>now);
      const triggerId='gap-recovery-'+kind;
      await engine.register({
        triggerId,version:'1',conditionOnly:true,
        clauses:[{id:'a',event:'job.started',serverId:'upstream',arguments:{},where:[]},
          {id:'b',event:'job.failed',serverId:'upstream',arguments:{},where:[]}],
        pattern:{version:'2',root,partitionBy:[],
          selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:10},
          execution:{maxCandidates:16,maxSemanticEvaluations:0,maxBufferedEvents:32}},
        withinMs:60000,
      });
      await store.putMcpClientState({
        connectionId:'source',serverId:'upstream',eventName:'job.failed',
        arguments:{},cursor:'gap:prior',truncated:true,deliveryMode:'poll',
      });
      const initial=await engine.ingest({
        traceId:'start:'+kind,sourceEventId:'start:'+kind,
        name:'job.started',serverId:'upstream',provider:'mcp',
        occurredAt:new Date(t0).toISOString(),subscriptionArguments:{},
        data:{},
      });
      assert.equal(initial.some(x=>x.matched),false,kind);
      assert.equal(store.listTemporalDeadlines({triggerId,status:'pending'}).length,1,
        kind+' must persist a durable retry BEFORE source repair');
      const consumer=new CompositeEventConsumer({
        store,triggerEngine:engine,wakeCoordinators:new Map(),
      });
      const scheduler=new TemporalDeadlineScheduler({
        store,compositeEventConsumer:consumer,now:()=>now,
      });
      now=new Date(t0+2000);
      const blocked=await scheduler.runDue();
      assert.deepEqual(blocked.map(x=>x.status),['deferred'],kind);
      assert.equal(store.listTriggerMatches(triggerId)
        .filter(x=>x.status==='matched').length,0,kind);

      manager=new McpEventsClientManager({
        store,compositeEventConsumer:consumer,
      });
      manager.addConnection({
        connectionId:'source',serverId:'upstream',
        request:async()=>({}),
        getCapabilities:async()=>({}),
      });
      const cleared=await manager.acknowledgeReconciledGap({
        connectionId:'source',eventName:'job.failed',
        arguments:{},evidenceId:'host-replay-verified:'+kind,
      });
      assert.equal(cleared.gapUnresolved,false,kind);
      assert.equal(cleared.reconciliationEvidenceId,'host-replay-verified:'+kind);
      const delivered=await scheduler.runDue();
      assert.deepEqual(delivered.map(x=>x.status),['fired'],kind);
      assert.equal(store.listTriggerMatches(triggerId)
        .filter(x=>x.status==='matched').length,1,kind);
      assert.deepEqual(await scheduler.runDue(),[],kind);
      await manager.close();
      manager=null;
      await store.close();
      store=new PersistentEventStore(dir);
      await store.init();
      assert.equal(store.getMcpClientState('source','job.failed').gapUnresolved,false);
      assert.equal(store.listTemporalDeadlines({triggerId,status:'pending'}).length,0);
    } finally {
      await manager?.close();
      await store?.close();
      await rm(dir,{recursive:true,force:true});
    }
  }
});
