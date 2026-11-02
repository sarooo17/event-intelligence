import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
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
