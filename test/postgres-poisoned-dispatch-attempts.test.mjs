import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';

const url=process.env.POSTGRES_URL;
const {Pool}=url ? await import('pg') : {Pool:null};
const integration=url ? test : test.skip;

function definition(id) {
  return {
    triggerId:id,version:'1',
    clauses:[{id:'ready',event:'fixture.poisoned.pool',
      arguments:{},where:[{path:'slot',op:'eq',value:7}]}],
    pattern:{version:'2',root:{kind:'event',ref:'ready'}},
    withinMs:60000,
    lifecycle:{oneShot:false,cooldownMs:0,completeOnGoal:false},
    target:{runtime:'fixture-host',kind:'task',id},
  };
}

async function fixture(run) {
  const prefix='ei_poisonretry_'+randomBytes(5).toString('hex');
  const pool=new Pool({connectionString:url,max:3,query_timeout:5000,statement_timeout:5000});
  const store=new PostgresEventStore({
    pool,dispatchPoolIdentity:pool,tablePrefix:prefix,scopeId:'poisoned-retry',
  });
  try {
    await store.init();
    const engine=new CompositeTriggerEngine(store);
    const id='poison-attempt-scenario';
    await engine.register(definition(id));
    const results=await engine.ingest({
      sourceEventId:'poison-event-1',traceId:'poison-trace-1',
      serverId:'fixture-provider',name:'fixture.poisoned.pool',
      occurredAt:new Date().toISOString(),data:{slot:7},
    });
    const match=results.find(row=>row.matched && row.triggerId===id)?.match;
    assert.ok(match,'real PG trigger must create a durable matched record');
    await run({store,engine,match});
  } finally {
    try {
      for(const kind of ['metadata','leases','history','records','counters']){
        await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+kind+'" CASCADE');
      }
    } finally {
      await pool.end();
    }
  }
}

integration('poisoned admission does not spend six host-attempt budgets or enter DLQ; later dispatch succeeds',async()=>fixture(async({store,engine,match})=>{
  let clock=Date.now(),hostCalls=0;
  const original=store.withTriggerDispatchFence.bind(store);
  const poisoned=new Error('physical pool requires recycle');
  poisoned.code='EVENT_INTELLIGENCE_DISPATCH_POOL_QUARANTINED';
  store.withTriggerDispatchFence=async()=>{throw poisoned;};
  const coordinator=new CompositeWakeCoordinator({
    store,triggerEngine:engine,workerId:'poisoned-gate-worker',
    now:()=>new Date(clock),maxAttempts:2,retryBaseDelayMs:1000,
    deliverer:async()=>{
      hostCalls++;
      return {runtimeReceiptId:'host-after-recycle'};
    },
  });
  try {
    let wakeId;
    for(let i=1;i<=6;i++){
      clock+=10000;
      const result=await coordinator.deliverMatched(match);
      assert.equal(result.status,'retry_scheduled');
      assert.equal(result.delivery.status,'retry_pending');
      assert.equal(result.delivery.attemptCount,i);
      assert.equal(result.delivery.dispatchContentions,i);
      assert.equal(hostCalls,0,'host callback must never run under pool poison');
      wakeId=result.wake.wakeId;
      assert.equal((await store.getWakeDelivery(wakeId)).status,'retry_pending',
        'DLQ threshold must not be spent by failed admission');
    }
    store.withTriggerDispatchFence=original;
    clock+=10000;
    const delivered=await coordinator.deliverMatched(match);
    assert.equal(delivered.status,'wake_delivered');
    assert.equal(hostCalls,1);
    const durable=await store.getWakeDelivery(delivered.wake.wakeId);
    assert.equal(durable.status,'delivered');
    assert.equal(durable.attemptCount,7);
    assert.equal(durable.dispatchContentions,6);
    assert.equal(durable.runtimeReceiptId,'host-after-recycle');
    assert.equal(await store.verifyAudit(),true);
  } finally {
    store.withTriggerDispatchFence=original;
  }
}));

integration('post-host uncertainty is NOT silently classified as no-host pool admission',async()=>fixture(async({store,engine,match})=>{
  let hostCalls=0;
  const uncertain=new Error('session unlock uncertain after host attempt');
  uncertain.code='EVENT_INTELLIGENCE_DISPATCH_SESSION_QUARANTINED';
  const coordinator=new CompositeWakeCoordinator({
    store,triggerEngine:engine,workerId:'post-host-uncertain',
    maxAttempts:1,deliverer:async()=>{
      hostCalls++;
      throw uncertain;
    },
  });
  const result=await coordinator.deliverMatched(match);
  assert.equal(hostCalls,1,'real host attempt was entered');
  assert.equal(result.status,'dead_letter');
  const durable=await store.getWakeDelivery(result.wake.wakeId);
  assert.equal(durable.status,'dead_letter');
  assert.equal(durable.attemptCount,1);
  assert.equal(durable.dispatchContentions??0,0);
}));
