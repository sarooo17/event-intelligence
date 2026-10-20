import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import test from 'node:test';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';

const url=process.env.POSTGRES_URL;
const {Pool}=url ? await import('pg') : {Pool:null};
const integration=url ? test : test.skip;
const cutoff='2026-10-10T00:00:00Z';
const at='2026-10-05T10:00:00.000Z';
const tables=['metadata','leases','history','records','counters'];

function wake(wakeId,status){
  return {wakeId,traceId:'retention-trace',decisionId:null,
    subscriptionId:'trigger:retention-trigger',
    sourceEventId:'match-for-'+wakeId,createdAt:at,status,
    target:{runtime:'fixture-host',kind:'task',id:wakeId}};
}
async function delivered(store,wakeId){
  await store.ensureWakeDelivery({wakeId,matchId:'match-for-'+wakeId,
    triggerId:'retention-trigger',triggerVersion:'1',
    runtime:'fixture-host',now:at});
  const claim=await store.claimWakeDelivery(wakeId,{
    workerId:'retention-worker',now:at,leaseMs:1000});
  assert.ok(claim);
  const receipt=await store.completeWakeDelivery(wakeId,{
    workerId:'retention-worker',attemptCount:claim.attemptCount,
    runtimeReceiptId:'durable-host-'+wakeId,
    now:'2026-10-05T10:00:00.500Z'});
  assert.equal(receipt.status,'delivered');
}
async function fixture(fn){
  const prefix='ei_wakeret_'+randomBytes(5).toString('hex');
  const poolA=new Pool({connectionString:url,max:4,statement_timeout:5000});
  const poolB=new Pool({connectionString:url,max:4,statement_timeout:5000});
  const a=new PostgresEventStore({pool:poolA,dispatchPoolIdentity:poolA,
    tablePrefix:prefix,scopeId:'tenant-A'});
  const contender=new PostgresEventStore({pool:poolB,dispatchPoolIdentity:poolB,
    tablePrefix:prefix,scopeId:'tenant-A'});
  const b=new PostgresEventStore({pool:poolB,dispatchPoolIdentity:poolB,
    tablePrefix:prefix,scopeId:'tenant-B'});
  try{
    await Promise.all([a.init(),contender.init(),b.init()]);
    await fn({a,contender,b,poolA,poolB,prefix});
  }finally{
    try {
      for(const kind of tables) {
        await poolA.query('DROP TABLE IF EXISTS "'+prefix+'_'+kind+'" CASCADE');
      }
    }finally{await Promise.allSettled([poolA.end(),poolB.end()]);}
  }
}

integration('PG16 two-pool wake retention preserves every status transition, current wake, durable receipt, tenant isolation and audit',()=>fixture(async({a,contender,b,poolA,prefix})=>{
  const id='delivered-with-duplicate-history',pendingId='pending-with-duplicates';
  const Q=wake(id,'queued'),D=wake(id,'delivered');
  for(let i=0;i<5;i++) await a.appendWake(Q);
  for(let i=0;i<4;i++) await a.appendWake(D);
  await delivered(a,id);
  for(let i=0;i<5;i++) await a.appendWake(wake(pendingId,'queued'));
  for(let i=0;i<5;i++) await b.appendWake(Q);
  await a.appendAudit({
    auditId:'wake-retention-audit',traceId:'retention-trace',timestamp:at,
    kind:'trigger.created',entityType:'trigger',entityId:'retention-trigger',
    details:{secret:'audit-chain-must-not-be-pruned'},
  });
  const table='"'+prefix+'_history"';
  await poolA.query('UPDATE '+table+
    ' SET created_at=$1::timestamptz WHERE kind=$2 AND scope_id=ANY($3)',
    ['2026-10-08T00:00:00Z','wake',['tenant-A','tenant-B']]);
  assert.equal(await a.verifyAudit(),true);
  const original=(await a.restoredCounts()).wakes;
  assert.equal(original,14);
  const dry=await a.compactDeliveredWakeDuplicateHistory({
    wakeId:id,before:cutoff,maxRows:2});
  assert.equal(dry.deleted,0);
  assert.equal(dry.eligible,2);
  assert.equal(dry.capped,true);
  assert.equal((await a.restoredCounts()).wakes,14);
  for(const flag of [true,false]){
    await assert.rejects(()=>a.compactDeliveredWakeDuplicateHistory({
      wakeId:id,before:cutoff,maxHistoryRows:8,dryRun:flag,
    }),e=>e.code==='EVENT_INTELLIGENCE_WAKE_HISTORY_SCAN_BUDGET_EXCEEDED');
  }
  assert.equal((await a.restoredCounts()).wakes,14);
  const first=await a.compactDeliveredWakeDuplicateHistory({
    wakeId:id,before:cutoff,maxRows:2,dryRun:false});
  assert.equal(first.deleted,2);
  const competing=await Promise.all([
    a.compactDeliveredWakeDuplicateHistory({
      wakeId:id,before:cutoff,maxRows:3,dryRun:false}),
    contender.compactDeliveredWakeDuplicateHistory({
      wakeId:id,before:cutoff,maxRows:3,dryRun:false}),
  ]);
  assert.equal(competing.reduce((n,row)=>n+row.deleted,0),3);
  const again=await contender.compactDeliveredWakeDuplicateHistory({
    wakeId:id,before:cutoff,dryRun:false});
  assert.equal(again.deleted,0,'idempotent bounded operator pruning');
  const hist=await poolA.query('SELECT payload FROM '+table+
    ' WHERE scope_id=$1 AND kind=$2 AND record_key=$3 ORDER BY history_id',
    ['tenant-A','wake',id]);
  assert.deepEqual(hist.rows.map(x=>x.payload),[Q,Q,D,D]);
  assert.deepEqual(await contender.latestWake(id),D);
  assert.equal((await contender.getWakeDelivery(id)).runtimeReceiptId,
    'durable-host-'+id);
  assert.equal(await a.claimWakeDelivery(id,{
    workerId:'unexpected',now:'2026-10-05T10:00:05.000Z'}),null,
    'delivered receipt still fences redispatch');
  const duplicate=await contender.appendDeliveredWakeIfMissing(D);
  assert.equal(duplicate.appended,false);
  assert.equal((await a.restoredCounts()).wakes,original-5);
  assert.equal((await b.restoredCounts()).wakes,5,
    'same wake ID in foreign tenant is not touched');
  assert.equal((await a.compactDeliveredWakeDuplicateHistory({
    wakeId:pendingId,before:cutoff,dryRun:false,
  })).skipped,'not_durably_delivered');
  assert.equal((await a.restoredCounts()).wakes,9);
  assert.equal(await a.verifyAudit(),true);
  assert.equal((await a.listAudit()).length,1);
  for(const invalid of [
    {},{wakeId:id,before:'2026-10-10'},
    {wakeId:id,before:'2999-01-01T00:00:00Z'},
    {wakeId:id,before:cutoff,maxRows:0},
    {wakeId:id,before:cutoff,maxRows:1001},
    {wakeId:id,before:cutoff,maxHistoryRows:2},
    {wakeId:id,before:cutoff,maxHistoryRows:100001},
    {wakeId:id,before:cutoff,maxScanMs:99},
    {wakeId:id,before:cutoff,maxScanMs:30001},
    {wakeId:id,before:cutoff,dryRun:'false'},
  ]) {
    await assert.rejects(
      ()=>a.compactDeliveredWakeDuplicateHistory(invalid),
      e=>e.code==='EVENT_INTELLIGENCE_WAKE_HISTORY_RETENTION_INVALID');
  }
}));

integration('PG16 operator timeout under independent wake writer lock aborts without deleting snapshots',()=>fixture(async({a,poolA,poolB,prefix})=>{
  const id='wake-history-timeout';
  for(let i=0;i<4;i++)await a.appendWake(wake(id,'delivered'));
  await delivered(a,id);
  await poolA.query('UPDATE "'+prefix+'_history"'+
    ' SET created_at=$1::timestamptz WHERE scope_id=$2 AND kind=$3',
    ['2026-10-08T00:00:00Z','tenant-A','wake']);
  const old=await a.restoredCounts();
  const holder=await poolB.connect();
  try{
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
      prefix+':tenant-A:wake-delivered-history:'+id]);
    await assert.rejects(
      ()=>a.compactDeliveredWakeDuplicateHistory({
        wakeId:id,before:cutoff,maxScanMs:150,dryRun:false}),
      e=>e.code==='EVENT_INTELLIGENCE_WAKE_HISTORY_TIME_BUDGET_EXCEEDED',
    );
  }finally{
    await holder.query('ROLLBACK');
    holder.release();
  }
  assert.deepEqual(await a.restoredCounts(),old);
  assert.deepEqual(await a.latestWake(id),wake(id,'delivered'));
  assert.equal((await a.getWakeDelivery(id)).runtimeReceiptId,'durable-host-'+id);
  assert.equal(await a.verifyAudit(),true);
}));
