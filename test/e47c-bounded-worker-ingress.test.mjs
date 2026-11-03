import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {validateDeferredWorkerAdmission,waitForDurableReceiptCount} from
 '../scripts/validation/e47c-durable-ack-drain.mjs';
import {scheduleBoundedWorkerIngress,validateWorkerIngestReceipt} from
 '../scripts/validation/e47c-bounded-worker-ingress.mjs';

const receipt=(i,workerId)=>({
 accepted:true,workerId,matched:1,persistedDeliveredWakes:1,
 timings:{ingestToMatchMs:2+i,matchToWakeSamplesMs:[5+i]},
});
test('both real worker identities receive paced concurrent ingests',async()=>{
 const starts=[];
 const r=await scheduleBoundedWorkerIngress({
  count:10,rate:5,maxInflight:4,
  workerIds:['ei-a','ei-b'],
  send:async i=>{
   starts.push({i,ts:performance.now()});
   await new Promise(resolve=>setTimeout(resolve,260));
   return receipt(i,i%2?'ei-b':'ei-a');
  },
 });
 assert.equal(r.allAccepted,true);
 assert.equal(r.accepted,10);
 assert.equal(r.rows.length,10);
 assert.ok(r.peakInflight>=2);
 assert.ok(r.peakInflight<=4);
 assert.ok(r.offeredRate>3.5);
 for(let i=0;i<r.rows.length;i++){
  assert.equal(r.rows[i].workerId,i%2?'ei-b':'ei-a');
  assert.equal(r.rows[i].status,'accepted');
  assert.equal(r.responses[i].workerId,r.rows[i].workerId);
 }
});
test('over capacity is explicitly refused and never counted as a delivered wake',async()=>{
 const r=await scheduleBoundedWorkerIngress({
  count:10,rate:5,maxInflight:1,
  workerIds:['ei-a','ei-b'],
  send:async i=>{
   await new Promise(resolve=>setTimeout(resolve,450));
   return receipt(i,i%2?'ei-b':'ei-a');
  },
 });
 assert.equal(r.allAccepted,false);
 assert.ok(r.rejected>0);
 assert.ok(r.rows.some(row=>row.status==='backpressure-refused'));
});
test('worker ACK reasons are fixed safe codes, not proof of lost effects',async()=>{
 const cases=[
  [v=>{v.workerId='wrong-worker';},'E47C_WORKER_ACK_IDENTITY_MISMATCH'],
  [v=>{v.persistedDeliveredWakes=0;},'E47C_WORKER_ACK_IMMEDIATE_DELIVERY_MISSING'],
  [v=>{v.persistedDeliveredWakes=2;},'E47C_WORKER_ACK_IMMEDIATE_DELIVERY_MISSING'],
  [v=>{v.matched=2;},'E47C_WORKER_ACK_MATCH_COUNT_INVALID'],
  [v=>{v.timings.ingestToMatchMs=-1;},'E47C_WORKER_ACK_INGEST_TIMING_INVALID'],
  [v=>{v.timings.matchToWakeSamplesMs=[];},'E47C_WORKER_ACK_WAKE_TIMING_INVALID'],
  [v=>{v.accepted=false;},'E47C_WORKER_ACK_NOT_ACCEPTED'],
 ];
 for(const [mutate,code] of cases){
  const r=receipt(0,'ei-a');mutate(r);
  assert.throws(()=>validateWorkerIngestReceipt(r,'ei-a'),e=>e.message===code);
 }
 const r=await scheduleBoundedWorkerIngress({
  count:10,rate:5,maxInflight:4,workerIds:['ei-a','ei-b'],
  send:async i=>i===3?receipt(i,'ei-a'):receipt(i,i%2?'ei-b':'ei-a'),
 });
 assert.equal(r.allAccepted,false);
 assert.ok(r.rows.some(x=>x.status==='failed'&&
  x.errorCode==='E47C_WORKER_ACK_IDENTITY_MISMATCH'));
});
test('worker schedule refuses spoofed identities and unsafe caps',async()=>{
 for(const workerIds of [[],['a'],['a','a'],[1,2]]){
  await assert.rejects(scheduleBoundedWorkerIngress({
   count:10,rate:5,workerIds,send:async()=>receipt(1,'a'),
  }),/E47C_WORKER_INGRESS_CONFIG_INVALID/);
 }
 await assert.rejects(scheduleBoundedWorkerIngress({
  count:10,rate:5,maxInflight:100,
  workerIds:['a','b'],send:async()=>receipt(1,'a'),
 }),/E47C_BAD_OPEN_LOOP_CONFIGURATION/);
});

test('deferred worker admission accepts exactly one persisted match without forcing immediate host delivery',()=>{
 const fromWorker={accepted:true,workerId:'worker-a',matched:1,
  persistedDeliveredWakes:0,
  timings:{ingestToMatchMs:13,matchToWakeSamplesMs:[]}};
 assert.equal(validateDeferredWorkerAdmission(fromWorker,'worker-a'),fromWorker);
 const forbidden=[
  [x=>{x.matched=0;},'E47C_WORKER_ACK_MATCH_COUNT_INVALID'],
  [x=>{x.persistedDeliveredWakes=2;},'E47C_WORKER_ACK_DELIVERY_COUNT_INVALID'],
  [x=>{x.timings.matchToWakeSamplesMs=[2];},'E47C_WORKER_ACK_WAKE_TIMING_INVALID'],
  [x=>{x.workerId='wrong-worker';},'E47C_WORKER_ACK_IDENTITY_MISMATCH'],
 ];
 for(const [mutate,code] of forbidden){
  const row=structuredClone(fromWorker);mutate(row);
  assert.throws(()=>validateDeferredWorkerAdmission(row,'worker-a'),
   e=>e.code===code);
 }
});
test('bounded receipt drain waits for late durable host effects; exact lineage is still required',async()=>{
 let clock=0,n=0;
 const receipts=[0,7,10,10],delivered=[0,5,9,10];
 const r=await waitForDurableReceiptCount({
  expectedCount:10,maxWaitMs:3000,pollMs:200,
  now:()=>clock,wait:async ms=>{clock+=ms;},
  readCounts:async()=>{
   const index=Math.min(n++,receipts.length-1),count=receipts[index];
   return {receipts:count,uniqueWakes:count,uniqueReceipts:count,
    delivered:delivered[index]};
  }
 });
 assert.equal(r.settledCount,10);
 assert.equal(r.durableDelivered,10);
 assert.equal(r.polls,4);
 assert.equal(r.drainElapsedMs,600);
 assert.equal(r.requirePerEventLineage,true);
 assert.equal(r.productionSloCertified,false);
});
test('bounded receipt drain rejects missing, duplicated, over-counted or timed-out outcomes',async()=>{
 const base={expectedCount:10,maxWaitMs:1000,pollMs:250};
 for(const response of [
  {receipts:10,uniqueWakes:9,uniqueReceipts:10,delivered:10},
  {receipts:11,uniqueWakes:11,uniqueReceipts:11,delivered:11},
  {receipts:10,uniqueWakes:10,uniqueReceipts:9,delivered:10},
  {receipts:10,uniqueWakes:10,uniqueReceipts:'10',delivered:10}
 ]){
  await assert.rejects(waitForDurableReceiptCount({
   ...base,readCounts:async()=>response
  }),/E47C_DURABLE_DRAIN_COUNT_MISMATCH/);
 }
 let clock=0;
 await assert.rejects(waitForDurableReceiptCount({...base,now:()=>clock,
  wait:async ms=>{clock+=ms;},
  readCounts:async()=>({receipts:9,uniqueWakes:9,uniqueReceipts:9,delivered:9})
 }),/E47C_DURABLE_DRAIN_TIMEOUT/);
 await assert.rejects(waitForDurableReceiptCount({
  expectedCount:10,maxWaitMs:0,pollMs:100,readCounts:async()=>({})
 }),/E47C_DURABLE_DRAIN_CONFIG_INVALID/);
});

test('eventual ACK mode counts admitted-but-not-yet-delivered responses, never runner refusals',async()=>{
 const deferred=(i,id)=>({accepted:true,workerId:id,matched:1,
  persistedDeliveredWakes:0,
  timings:{ingestToMatchMs:3+i,matchToWakeSamplesMs:[]}});
 const job=await scheduleBoundedWorkerIngress({count:10,rate:5,maxInflight:4,
  deliveryMode:'eventual',workerIds:['ei-a','ei-b'],
  send:async i=>i===3?deferred(i,'ei-b'):receipt(i,i%2?'ei-b':'ei-a')});
 assert.equal(job.allAccepted,true);
 assert.equal(job.rejected,0);
 assert.equal(job.responses[3].persistedDeliveredWakes,0);
 const invalid=await scheduleBoundedWorkerIngress({count:10,rate:5,maxInflight:4,
  deliveryMode:'eventual',workerIds:['ei-a','ei-b'],
  send:async i=>i===3?{...deferred(i,'ei-b'),matched:0}:
   receipt(i,i%2?'ei-b':'ei-a')});
 assert.equal(invalid.allAccepted,false);
 assert.equal(invalid.rows[3].errorCode,'E47C_WORKER_ACK_MATCH_COUNT_INVALID');
});

test('query crossing the drain deadline never certifies a late receipt',async()=>{
 let clock=0;
 await assert.rejects(waitForDurableReceiptCount({
  expectedCount:10,maxWaitMs:1000,pollMs:200,
  now:()=>clock,wait:async ms=>{clock+=ms;},
  readCounts:async({remainingMs})=>{
   assert.equal(remainingMs,1000);
   clock=5000;
   return {receipts:10,uniqueWakes:10,uniqueReceipts:10,delivered:10};
  }
 }),/E47C_DURABLE_DRAIN_TIMEOUT/);
});

test('1k open-loop worker offers require explicit count budget and preserve 5/s schedule',async()=>{
 let clock=0;
 const send=async i=>receipt(i,i%2?'ei-b':'ei-a');
 const settings={count:1000,rate:5,maxInflight:8,
  workerIds:['ei-a','ei-b'],send,now:()=>clock,
  wait:async ms=>{clock+=ms;}};
 await assert.rejects(scheduleBoundedWorkerIngress(settings),
  /E47C_BAD_OPEN_LOOP_CONFIGURATION/);
 const run=await scheduleBoundedWorkerIngress({...settings,maxCount:1000});
 assert.equal(run.rows.length,1000);
 assert.equal(run.accepted,1000);
 assert.equal(run.rejected,0);
 assert.equal(run.allAccepted,true);
 assert.equal(run.offeredRate,5);
 assert.equal(run.rows[999].scheduledAtMs,199800);
 assert.ok(run.peakInflight<=8);
});

test('1k durable receipt polling requires explicit maxExpectedCount and 1000 unique delivered',async()=>{
 const readCounts=async()=>({receipts:1000,uniqueWakes:1000,
  uniqueReceipts:1000,delivered:1000});
 await assert.rejects(waitForDurableReceiptCount({
  expectedCount:1000,readCounts}),/E47C_DURABLE_DRAIN_CONFIG_INVALID/);
 const accepted=await waitForDurableReceiptCount({
  expectedCount:1000,maxExpectedCount:1000,readCounts});
 assert.equal(accepted.settledCount,1000);
 assert.equal(accepted.durableDelivered,1000);
 assert.equal(accepted.productionSloCertified,false);
 await assert.rejects(waitForDurableReceiptCount({
  expectedCount:1000,maxExpectedCount:1001,readCounts
 }),/E47C_DURABLE_DRAIN_CONFIG_INVALID/);
});
