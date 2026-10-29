import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
import {createPostgresSemanticAdmission} from '../scripts/lib/postgres-semantic-admission.mjs';
const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const prefix='ei_sem_budget_'+randomBytes(6).toString('hex');
const budget={maxTriggerCalls:3,maxTriggerTokens:9,maxTriggerCostMicros:21,
  maxBatchCalls:2,maxBatchTokens:6,maxBatchCostMicros:14};
const req={namespace:'issue@1',nodeId:'importance',
  candidateSignature:'[["event","opaque-id"]]',
  evaluatorIdentity:'host/synthetic-v1',
  inputBytes:25,instructionBytes:27};
const estimator=()=>({tokens:3,costMicros:7});
function storage(pool,tenant){return new PostgresEventStore({
  pool,dispatchPoolIdentity:pool,tablePrefix:prefix,scopeId:tenant,
});}
function gate(store,batchId='one',b=budget){return createPostgresSemanticAdmission({
  store,budget:b,batchId,budgetEpoch:'policy-1',estimate:estimator,
});}
integration('real PG16 two independent pools atomically enforce trigger + batch call/token/cost caps across restart and tenant',async()=>{
  const aPool=new Pool({connectionString:url,max:3});
  const bPool=new Pool({connectionString:url,max:3});
  const a=storage(aPool,'tenant-a');
  const b=storage(bPool,'tenant-a');
  const foreign=storage(bPool,'tenant-b');
  try{
    await a.init();await b.init();await foreign.init();
    const first=gate(a),racer=gate(b);
    const attempts=await Promise.all(Array.from({length:10},(_,i)=>
      (i%2?first:racer).reserve(req)));
    assert.equal(attempts.filter(Boolean).length,2,
      'maxBatchCalls=2 must hold under two separate pg pools');
    const denied=await gate(a).reserve(req);
    assert.equal(denied,false);
    const secondBatch=gate(b,'two');
    assert.equal(await secondBatch.reserve(req),true);
    assert.equal(await secondBatch.reserve(req),false,
      'trigger scope limit=3 must remain after fresh batch');
    assert.equal(await gate(foreign).reserve(req),true,
      'foreign tenant with same key must not inherit quota');
    const newPool=new Pool({connectionString:url,max:2});
    try{
      const restarted=storage(newPool,'tenant-a');
      await restarted.init();
      assert.equal(await gate(restarted,'three').reserve(req),false,
        'PG persisted quota survives another pool and store initialization');
      assert.equal(await gate(storage(newPool,'tenant-b'),'other').reserve(req),true);
    }finally{await newPool.end();}
    const newEpoch=createPostgresSemanticAdmission({
      store:a,budget,batchId:'one',budgetEpoch:'policy-2',estimate:estimator,
    });
    assert.equal(await newEpoch.reserve(req),true,
      'new explicitly host-owned policy epoch resets an old budget');
  }finally{
    for(const suffix of ['metadata','leases','history','records','counters']){
      await aPool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    }
    await aPool.end();await bPool.end();
  }
});
integration('PG16 budget refuses untrusted malformed costs and corrupt stored counters',async()=>{
  const pool=new Pool({connectionString:url,max:3});
  const st=storage(pool,'invalid-case');
  try{
    await st.init();
    const bad=createPostgresSemanticAdmission({
      store:st,budget,batchId:'batch',estimate:()=>({tokens:-1,costMicros:7}),
    });
    assert.equal(await bad.reserve(req),false);
    assert.equal(await gate(st,'batch').reserve({...req,inputBytes:131073}),false);
    assert.throws(()=>gate(st,'batch',{...budget,maxBatchCalls:-1}),RangeError);
    await st.upsert('semantic_budget','trigger:'+JSON.stringify(['issue@1','policy-1']),
      {calls:-1,tokens:1,costMicros:1});
    await assert.rejects(()=>gate(st,'batch').reserve(req),/Corrupt semantic budget ledger/);
  }finally{
    for(const suffix of ['metadata','leases','history','records','counters']){
      await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    }
    await pool.end();
  }
});

integration('PG16 host-authored trigger/batch deadlines survive independent pools, expire and reset only in new epoch',async()=>{
  const pool=new Pool({connectionString:url,max:3});
  const independent=new Pool({connectionString:url,max:3});
  const scoped=storage(pool,'time-scope');
  const other=storage(independent,'time-scope');
  const timed={...budget,maxTriggerWindowMs:350,maxBatchWindowMs:350};
  const make=(store,epoch='clock-1',batchId='first')=>
    createPostgresSemanticAdmission({store,batchId,budgetEpoch:epoch,
      budget:timed,estimate:estimator});
  try{
    await scoped.init();await other.init();
    assert.equal(await make(scoped).reserve(req),true);
    const triggerKey='trigger:'+JSON.stringify(['issue@1','clock-1']);
    const initial=await scoped.get('semantic_budget',triggerKey);
    assert(Number.isSafeInteger(initial.deadlineAtMs));
    assert.equal(await make(other).reserve(req),true);
    await new Promise(resolve=>setTimeout(resolve,600));
    assert.equal(await make(scoped,'clock-1','brand-new-batch').reserve(req),false,
      'fresh batch must not extend a trigger window after expiry');
    assert.equal(await make(other).reserve(req),false,
      'new pool cannot reopen expired budget');
    assert.equal((await scoped.get('semantic_budget',triggerKey)).deadlineAtMs,
      initial.deadlineAtMs,'expired budget must remain durable and unmodified');
    assert.equal(await make(other,'clock-2').reserve(req),true,
      'operator-selected new policy epoch starts a fresh accounting window');
    const newWindow=await scoped.get('semantic_budget',
      'trigger:'+JSON.stringify(['issue@1','clock-2']));
    assert(newWindow.deadlineAtMs>initial.deadlineAtMs);
    assert.throws(()=>createPostgresSemanticAdmission({
      store:scoped,batchId:'first',
      budget:{...timed,maxBatchWindowMs:2},estimate:estimator,
    }),/time window/);
    assert.equal(await make(scoped,'clock-2','first')
      .reserve({...req,namespace:''}),false,'invalid identity is denied');
  }finally{
    for(const suffix of ['metadata','leases','history','records','counters']){
      await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    }
    await pool.end();await independent.end();
  }
});
