import test from 'node:test';
import assert from 'node:assert/strict';
import {assessProgressiveE47CStage} from '../scripts/validation/e47c-progressive-1k-recheck.mjs';

function fixture(rate=1){
 const source=[],host=[],ei=[],originalEvents=[],originalSequenceById=new Map();
 for(let i=0;i<50;i++){
  const eventId='e47c-'+i,wakeId='wake-'+i,receipt='receipt-'+i;
  originalSequenceById.set(eventId,i+2);
  source.push({eventId,sourceSequence:i+2,occurredAt:'2026-11-02T19:00:00.000Z',slot:i});
  host.push({eventId,wakeId,runtimeReceiptId:receipt,attemptCount:1});
  ei.push({eventId,wakeId,runtimeReceiptId:receipt,
   workerId:i%2?'worker-b':'worker-a',
   ingestToMatchMs:1,matchToWakeMs:2,
   workerRequestToHostReceiptMs:20});
  originalEvents.push({eventId,timestamp:'2026-11-02T19:00:00.000Z',data:{slot:i}});
 }
 return {manifest:{
  schema:'ei.e47c.progressive-1k-preflight.v1',
  acceptanceE47CVerified:false,productionSloCertified:false,
  stage:{sourceOracleVerified:true,hostDbSharedWithEI:true,
   events:50,triggers:1000,requestedRatePerSecond:rate,
   offeredEventRateMeasuredPerSecond:rate*0.9,
   durationSeconds:60,observed:50,hostWakeReceipts:50,
   duplicateHostEffects:0,sourceEventLogSha256:'a'.repeat(64),
   workerRequestToHostReceiptMs:{p50:20,p95:20,p99:20}},
 },source,host,ei,originalEvents,originalSequenceById};
}
test('one of two 1k stage rates: full 50 raw samples verified but NO certification',()=>{
 for(const rate of [1,5]){
  const result=assessProgressiveE47CStage(fixture(rate));
  assert.equal(result.triggerCount,1000);
  assert.equal(result.eventCount,50);
  assert.equal(result.requestedRatePerSecond,rate);
  assert.equal(result.acceptanceE47CVerified,false);
  assert.equal(result.productionSloCertified,false);
 }
});
test('unsafe self-reported rates, duplicated source sequences, forged receipt or p99 fail closed',()=>{
 const attacks=[
  f=>{f.manifest.stage.triggers=10000;},
  f=>{f.manifest.stage.requestedRatePerSecond=2;},
  f=>{f.manifest.stage.offeredEventRateMeasuredPerSecond=0;},
  f=>{f.source[0].sourceSequence=f.source[1].sourceSequence;},
  f=>{f.source[0].sourceSequence=0;},
  f=>{f.originalSequenceById.set(f.source[0].eventId,10000);},
  f=>{f.host[0].runtimeReceiptId='falsified';},
  f=>{f.manifest.stage.workerRequestToHostReceiptMs.p99=0.1;},
  f=>{f.ei.pop();},
  f=>{f.ei.forEach(v=>v.workerId='worker-a');},
  f=>{f.manifest.acceptanceE47CVerified=true;},
 ];
 for(const attack of attacks){const f=fixture();attack(f);
  assert.throws(()=>assessProgressiveE47CStage(f));}
});

function withOffers(){
 const f=fixture(5);
 f.manifest.ratePacingIsSerialAppend=false;
 f.manifest.offeredPacingIndependentOfAck=true;
 f.manifest.stage.maxSourceAppendInflight=4;
 f.manifest.stage.maxObservedSourceAppendInflight=1;
 f.manifest.stage.sourceAcceptedOffers=50;
 f.manifest.stage.sourceRejectedOffers=0;
 f.manifest.stage.offeredEventRateMeasuredPerSecond=5;
 f.manifest.stage.acceptedAppendCompletionRateMeasuredPerSecond=5;
 f.offers=f.source.map((row,i)=>({
  index:i,eventId:row.eventId,status:'accepted',
  scheduledAtMs:i*200,offeredAtMs:i*200,
  offerLatenessMs:0,completedAtMs:i*200+80,
  offerOrder:2*i+1,completedOrder:2*i+2,
 }));
 return f;
}
test('independent recheck accepts complete first-party open-loop offers but does not certify',()=>{
 const result=assessProgressiveE47CStage(withOffers());
 assert.equal(result.sourcePacingIsSerial,false);
 assert.equal(result.sourceOpenLoop.rate,5);
 assert.equal(result.sourceOpenLoop.completionRate,5);
 assert.equal(result.acceptanceE47CVerified,false);
});
test('independent recheck rejects forged pacing, censored offers, bad peak or receipt mapping',()=>{
 const attacks=[
  f=>{f.offers.pop();},
  f=>{f.offers[0].status='failed';},
  f=>{f.offers[0].eventId=f.offers[1].eventId;},
  f=>{f.offers[4].offeredAtMs+=800;},
  f=>{f.offers[1].completedAtMs+=500;},
  f=>{f.manifest.stage.offeredEventRateMeasuredPerSecond=50;},
  f=>{f.manifest.stage.acceptedAppendCompletionRateMeasuredPerSecond=50;},
  f=>{delete f.manifest.stage.acceptedAppendCompletionRateMeasuredPerSecond;},
  f=>{f.manifest.stage.acceptedAppendCompletionRateMeasuredPerSecond='5';},
  f=>{f.offers[0].offerOrder=f.offers[1].offerOrder;},
  f=>{f.manifest.stage.maxObservedSourceAppendInflight=4;},
  f=>{f.manifest.stage.sourceRejectedOffers=1;},
  f=>{f.manifest.stage.maxSourceAppendInflight=9;},
 ];
 for(const attack of attacks){const f=withOffers();attack(f);
  assert.throws(()=>assessProgressiveE47CStage(f));}
});

test('zero-duration first ACK retains exact peak concurrency without phantom overlap',()=>{
 const f=withOffers();
 f.offers[0].completedAtMs=f.offers[0].offeredAtMs;
 // The first completion moved, so its measured completion rate changes.
 f.manifest.stage.acceptedAppendCompletionRateMeasuredPerSecond=4.96;
 const result=assessProgressiveE47CStage(f);
 assert.equal(result.sourceOpenLoop.peakInflight,1);
});
test('top-level completion throughput comes from completions, not source offers',()=>{
 const f=withOffers();
 // Keep every completion before the next scheduled offer; transition order
 // remains valid while ACK completion throughput differs from offered rate.
 f.offers.forEach((o,i)=>o.completedAtMs=o.offeredAtMs+80+2*i);
 f.manifest.stage.acceptedAppendCompletionRateMeasuredPerSecond=4.95;
 const result=assessProgressiveE47CStage(f);
 assert.equal(result.sourceOpenLoop.rate,5);
 assert.equal(result.sourceOpenLoop.completionRate,4.95);
 assert.equal(result.observedAppendCompletionRatePerSecond,4.95);
});


function withParallelIngress(){
 const f=withOffers();
 f.manifest.workerIngressPacingIndependentOfAck=true;
 const stage=f.manifest.stage;
 stage.workerIngestPacedIndependently=true;
 stage.workerIngressMaxInflight=4;
 stage.workerIngressPeakInflight=2;
 stage.workerIngressAccepted=50;
 stage.workerIngressRejected=0;
 stage.workerIngressOfferedRatePerSecond=5;
 stage.workerIngressCompletionRatePerSecond=5;
 stage.workerIngressWorkerIds=['worker-a','worker-b'];
 f.ingest=f.source.map((x,i)=>({
  index:i,eventId:x.eventId,workerId:i%2?'worker-b':'worker-a',
  status:'accepted',scheduledAtMs:i*200,offeredAtMs:i*200,
  offerLatenessMs:0,completedAtMs:i*200+300,
 }));
 const transitions=f.ingest.flatMap((row,i)=>[
  {i,kind:'offer',t:row.offeredAtMs},
  {i,kind:'complete',t:row.completedAtMs},
 ]).sort((a,b)=>a.t-b.t);
 transitions.forEach((row,index)=>{
  f.ingest[row.i][row.kind==='offer'?'offerOrder':'completedOrder']=index+1;
 });
 f.ei.forEach(r=>{r.workerRequestToHostReceiptMs=300;});
 stage.workerRequestToHostReceiptMs={p50:300,p95:300,p99:300};
 return f;
}
test('re-audit two EI worker ingesters with actual overlapping ACKs and 2 workers',()=>{
 const f=withParallelIngress();
 const result=assessProgressiveE47CStage(f);
 assert.equal(result.workerIngress.peakInflight,2);
 assert.equal(result.workerIngress.offeredRate,5);
 assert.equal(result.workerIngress.completionRate,5);
 assert.equal(result.distinctEIWorkers,2);
 assert.equal(result.productionSloCertified,false);
 assert.equal(result.acceptanceE47CVerified,false);
});
test('independent ingest evidence rejects tampering, censored rows and forged throughput',()=>{
 const attacks=[
  f=>{f.ingest.pop();},
  f=>{f.ingest[0].workerId='worker-b';},
  f=>{f.ingest[1].eventId=f.ingest[0].eventId;},
  f=>{f.ingest[1].status='backpressure-refused';},
  f=>{f.ingest[0].completedAtMs+=500;},
  f=>{f.ingest[0].offerOrder=f.ingest[1].offerOrder;},
  f=>{f.manifest.stage.workerIngressPeakInflight=1;},
  f=>{f.manifest.stage.workerIngressAccepted=49;},
  f=>{f.manifest.stage.workerIngressRejected=1;},
  f=>{f.manifest.stage.workerIngressWorkerIds=['worker-a','worker-a'];},
  f=>{f.manifest.stage.workerIngressOfferedRatePerSecond=50;},
  f=>{f.manifest.stage.workerIngressCompletionRatePerSecond=0;},
  f=>{delete f.manifest.stage.workerIngressCompletionRatePerSecond;},
  f=>{f.manifest.stage.workerIngressMaxInflight=9;},
  f=>{f.ei[0].workerRequestToHostReceiptMs=2;},
 ];
 for(const attack of attacks){
  const f=withParallelIngress();attack(f);
  assert.throws(()=>assessProgressiveE47CStage(f));
 }
});

function withEventualDurability(){
 const f=withParallelIngress();
 f.manifest.schema='ei.e47c.progressive-1k-durable-preflight.v2';
 f.manifest.stage.deliveryMode='eventual';
 f.manifest.stage.durableDrain={settledCount:50,durableDelivered:50,polls:3,
  drainElapsedMs:850,requirePerEventLineage:true,
  productionSloCertified:false};
 f.manifest.stage.deferredImmediateResponses=2;
 f.manifest.stage.workerRequestCompletionMs={p50:300,p95:300,p99:300};
 delete f.manifest.stage.workerRequestToHostReceiptMs;
 f.ei.forEach((row,i)=>{
  row.immediateDelivered=i!==4&&i!==31;
  row.matchToWakeMs=row.immediateDelivered?2:null;
  row.workerRequestCompletionMs=300;
  delete row.workerRequestToHostReceiptMs;
 });
 return f;
}
test('independent recheck records deferred samples as censored, not invented p99',()=>{
 const f=withEventualDurability();
 const result=assessProgressiveE47CStage(f);
 assert.equal(result.eventCount,50);
 assert.equal(result.latency.matchToWakeObservedSamples,48);
 assert.equal(result.latency.matchToWakeCensoredSamples,2);
 assert.equal(result.latency.workerRequestCompletion.p99,300);
 assert.equal(result.latency.workerRequestToHostReceipt,null);
 assert.equal(result.productionSloCertified,false);
});
test('eventual verifier rejects fake settlement, forged sample, missing response and misattribution',()=>{
 for(const change of [
  f=>{f.manifest.stage.durableDrain.settledCount=49;},
  f=>{f.manifest.stage.durableDrain.durableDelivered=49;},
  f=>{f.manifest.workerIngressPacingIndependentOfAck=false;f.ingest=undefined;},
  f=>{f.manifest.stage.durableDrain.requirePerEventLineage=false;},
  f=>{f.manifest.stage.durableDrain.productionSloCertified=true;},
  f=>{f.manifest.stage.deferredImmediateResponses=0;},
  f=>{f.ei[4].matchToWakeMs=5;},
  f=>{f.ei[31].immediateDelivered=true;},
  f=>{f.ei[10].workerRequestCompletionMs=-1;},
  f=>{f.ingest[0].status='backpressure-refused';},
  f=>{f.manifest.stage.workerRequestCompletionMs.p99=800;},
  f=>{f.host[0].runtimeReceiptId='not-a-host-receipt';},
 ]){const f=withEventualDurability();change(f);
  assert.throws(()=>assessProgressiveE47CStage(f));}
});
