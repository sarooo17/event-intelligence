import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes,createHash} from 'node:crypto';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
import {createPostgresSemanticAdmission} from '../scripts/lib/postgres-semantic-admission.mjs';
import {createPostgresSemanticUsageReconciler}
  from '../scripts/lib/semantic-provider-usage-reconciliation.mjs';

const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const prefix='ei_provider_usage_'+randomBytes(5).toString('hex');
const budget={maxTriggerCalls:4,maxTriggerTokens:120,maxTriggerCostMicros:360,
  maxBatchCalls:4,maxBatchTokens:120,maxBatchCostMicros:360};
function store(pool,scope){return new PostgresEventStore({pool,
  dispatchPoolIdentity:pool,tablePrefix:prefix,scopeId:scope});}
function admission(db){return createPostgresSemanticAdmission({
  store:db,budget,batchId:'one',budgetEpoch:'verified-1',
  estimate:()=>({tokens:30,costMicros:90}),
});}
function reconciler(db,verifier=async()=>true){
  return createPostgresSemanticUsageReconciler({
    store:db,budgetEpoch:'verified-1',verifyProviderReceipt:verifier,
  });
}
const req={namespace:'trigger@1',nodeId:'important',
  evaluatorIdentity:'host/provider/v1',candidateSignature:'opaque-event-id',
  inputBytes:12,instructionBytes:20};
function usage(reservationId,providerRequestId,other={}){
  return {namespace:'trigger@1',reservationId,providerRequestId,
    inputTokens:10,outputTokens:12,cachedInputTokens:2,
    reasoningOutputTokens:3,reportedCostMicros:75,
    priceVersion:'host-usd-2026-10',...other};
}
integration('PG16 provider-reported usage is scoped to one reserved call and idempotent across workers/restart',async()=>{
  const pa=new Pool({connectionString:url,max:3});
  const pb=new Pool({connectionString:url,max:3});
  const a=store(pa,'usage-A'),b=store(pb,'usage-A'),foreign=store(pb,'usage-B');
  try{
    await a.init();await b.init();await foreign.init();
    assert.equal(await admission(a).reserve({...req,reservationId:'call-1'}),true);
    let checked=0;
    const verify=async receipt=>{
      checked++;
      assert.equal(receipt.priceVersion,'host-usd-2026-10');
      assert.equal(receipt.namespace,'trigger@1');
      return true; // Reference adapter: independently verified receipt fixture.
    };
    const entries=await Promise.all(Array.from({length:6},(_,i)=>
      reconciler(i%2?a:b,verify).record(usage('call-1','provider-req-1'))));
    assert(entries.every(x=>x.status==='usage_observed_billing_unknown'));
    assert(entries.every(x=>x.billingConfirmed===false));
    assert(checked>=1);
    const digest=id=>createHash('sha256').update(id).digest('hex');
    const key='reservation:'+JSON.stringify(['trigger@1','verified-1',digest('call-1')]);
    const stored=await a.get('semantic_budget_receipt',key);
    assert.equal(stored.status,'usage_observed_billing_unknown');
    assert.equal(stored.billingConfirmed,false);
    assert.equal(JSON.stringify(stored).includes('provider-req-1'),false);
    const restarted=new Pool({connectionString:url,max:2});
    try{
      const fresh=store(restarted,'usage-A');await fresh.init();
      assert.equal((await reconciler(fresh).record(usage(
        'call-1','provider-req-1'))).billingConfirmed,false);
      await assert.rejects(()=>reconciler(fresh).record(usage(
        'call-1','provider-req-new')),e=>
        e.code==='EVENT_INTELLIGENCE_PROVIDER_USAGE_CONFLICT');
    }finally{await restarted.end();}
    assert.equal(await admission(a).reserve({...req,reservationId:'call-2'}),true);
    await assert.rejects(()=>reconciler(b).record(usage(
      'call-2','provider-req-1')),e=>
      e.code==='EVENT_INTELLIGENCE_PROVIDER_USAGE_CONFLICT',
      'one provider-issued request cannot settle two admissions');
    assert.equal((await reconciler(b).record(usage('call-2','provider-req-2',{
      inputTokens:35,outputTokens:20,reportedCostMicros:101,
    }))).status,'usage_exceeds_reservation');
    const caps=await a.get('semantic_budget',
      'trigger:'+JSON.stringify(['trigger@1','verified-1']));
    assert.deepEqual([caps.calls,caps.tokens,caps.costMicros],[2,60,180],
      'provider usage cannot refund or inflate reserved hard quotas');
    assert.equal(await admission(foreign).reserve({...req,reservationId:'call-1'}),true);
    await assert.rejects(()=>reconciler(foreign).record(usage(
      'unreserved','provider-req-3')),e=>
      e.code==='EVENT_INTELLIGENCE_PROVIDER_USAGE_NO_RESERVATION');
  }finally{
    for(const suffix of ['metadata','leases','history','records','counters']){
      await pa.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    }
    await pa.end();await pb.end();
  }
});
integration('invalid or unverified provider usage never changes a durable reservation',async()=>{
  const pool=new Pool({connectionString:url,max:3});
  const db=store(pool,'usage-unverified');
  try{
    await db.init();
    assert.equal(await admission(db).reserve({...req,reservationId:'call'}),true);
    await assert.rejects(()=>reconciler(db,async()=>false).record(
      usage('call','provider')),e=>
      e.code==='EVENT_INTELLIGENCE_PROVIDER_USAGE_UNVERIFIED');
    await assert.rejects(()=>reconciler(db).record(usage(
      'call','provider',{cachedInputTokens:500})),RangeError);
    await assert.rejects(()=>reconciler(db).record(usage(
      'call','provider',{reportedCostMicros:80,priceVersion:null})),RangeError);
    await assert.rejects(()=>createPostgresSemanticUsageReconciler({
      store:db,budgetEpoch:'verified-1',maxVerificationMs:10,
      verifyProviderReceipt:()=>{
        const end=process.hrtime.bigint()+35000000n;
        while(process.hrtime.bigint()<end){}
        return true;
      },
    }).record(usage('call','provider')),e=>
      e.code==='EVENT_INTELLIGENCE_PROVIDER_USAGE_UNVERIFIED');
    const digest=createHash('sha256').update('call').digest('hex');
    const reserved=await db.get('semantic_budget_receipt',
      'reservation:'+JSON.stringify(['trigger@1','verified-1',digest]));
    assert.equal(reserved.status,'reserved_billing_unknown');
    assert.equal(reserved.billingConfirmed,undefined);
  }finally{
    for(const suffix of ['metadata','leases','history','records','counters']){
      await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    }
    await pool.end();
  }
});
