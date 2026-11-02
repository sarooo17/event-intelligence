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
