import test from 'node:test';
import assert from 'node:assert/strict';
import {assessProgressiveE47CStage} from
 '../scripts/validation/e47c-progressive-1k-recheck.mjs';

// Deterministic 1k cohort with complete original-source/ingress/match/host
// identity across every event and an honest censored immediate delivery.
function largeFixture(){
 const rate=5,count=1000;
 const source=[],host=[],ei=[],offers=[],ingest=[],originalEvents=[];
 const originalSequenceById=new Map();
 for(let i=0;i<count;i++){
  const eventId='event-'+i,wakeId='wake-'+i,receiptId='receipt-'+i,
   workerId=i%2?'worker-b':'worker-a';
  const occurredAt='2026-11-03T11:00:00.000Z';
  source.push({eventId,sourceSequence:i+2,occurredAt,slot:i});
  host.push({eventId,wakeId,runtimeReceiptId:receiptId,attemptCount:1});
  originalEvents.push({eventId,timestamp:occurredAt,data:{slot:i}});
  originalSequenceById.set(eventId,i+2);
  const immediate=i!==611;
  ei.push({eventId,wakeId,runtimeReceiptId:receiptId,workerId,
   ingestToMatchMs:42,matchToWakeMs:immediate?3:null,
   immediateDelivered:immediate,workerRequestCompletionMs:300});
  offers.push({index:i,eventId,status:'accepted',scheduledAtMs:i*200,
   offeredAtMs:i*200,offerLatenessMs:0,completedAtMs:i*200+80,
   offerOrder:2*i+1,completedOrder:2*i+2});
  ingest.push({index:i,eventId,workerId,status:'accepted',
   scheduledAtMs:i*200,offeredAtMs:i*200,offerLatenessMs:0,
   completedAtMs:i*200+300});
 }
 const transitions=ingest.flatMap((r,i)=>[
  {index:i,type:'offerOrder',time:r.offeredAtMs},
  {index:i,type:'completedOrder',time:r.completedAtMs}
 ]).sort((a,b)=>a.time-b.time);
 transitions.forEach((t,index)=>{ingest[t.index][t.type]=index+1;});
 const manifest={
  schema:'ei.e47c.progressive-1k-durable-preflight.v3',
  acceptanceE47CVerified:false,productionSloCertified:false,
  ratePacingIsSerialAppend:false,offeredPacingIndependentOfAck:true,
  workerIngressPacingIndependentOfAck:true,sourceAndHostAreFirstParty:true,
  stage:{
   events:count,observed:count,triggers:count,
   deliveryMode:'eventual',largeEventOptIn:true,requestedEventBudget:1000,
   requestedRatePerSecond:rate,sourceOracleVerified:true,hostDbSharedWithEI:true,
   sourceFirstPartySeparateService:true,hostFirstPartySeparateService:true,
   independentEIPools:2,
   durationSeconds:420,hostWakeReceipts:count,duplicateHostEffects:0,
   sourceEventLogSha256:'b'.repeat(64),
   maxSourceAppendInflight:4,maxObservedSourceAppendInflight:1,
   sourceAcceptedOffers:count,sourceRejectedOffers:0,
   offeredEventRateMeasuredPerSecond:5,
   acceptedAppendCompletionRateMeasuredPerSecond:5,
   workerIngestPacedIndependently:true,
   workerIngressMaxInflight:8,workerIngressPeakInflight:2,
   workerIngressAccepted:count,workerIngressRejected:0,
   workerIngressOfferedRatePerSecond:5,
   workerIngressCompletionRatePerSecond:5,
   workerIngressWorkerIds:['worker-a','worker-b'],
   durableDrain:{settledCount:count,durableDelivered:count,
    polls:5,drainElapsedMs:2000,requirePerEventLineage:true,
    productionSloCertified:false},
   deferredImmediateResponses:1,
   workerRequestCompletionMs:{p50:300,p95:300,p99:300}
  }
 };
 return {manifest,source,host,ei,offers,ingest,originalEvents,originalSequenceById};
}
test('complete explicit 1000-event cohort reaudits without granting E47-C production SLO',()=>{
 const r=assessProgressiveE47CStage(largeFixture());
 assert.equal(r.eventCount,1000);
 assert.equal(r.stageSchema,'ei.e47c.progressive-1k-durable-preflight.v3');
 assert.equal(r.hostReceipts,1000);
 assert.equal(r.workerIngress.distinctWorkers,2);
 assert.equal(r.workerIngress.offeredRate,5);
 assert.equal(r.latency.matchToWakeObservedSamples,999);
 assert.equal(r.latency.matchToWakeCensoredSamples,1);
 assert.equal(r.latency.workerRequestCompletion.p99,300);
 assert.equal(r.productionSloCertified,false);
 assert.equal(r.acceptanceE47CVerified,false);
});
test('1000-event v3 rejects truncated/raw-false/duplicate/backpressure evidence',()=>{
 const attacks=[
  f=>{f.manifest.stage.events=999;},
  f=>{f.manifest.stage.largeEventOptIn=false;},
  f=>{f.manifest.stage.requestedEventBudget=250;},
  f=>{f.manifest.stage.independentEIPools=1;},
  f=>{f.manifest.sourceAndHostAreFirstParty=false;},
  f=>{f.manifest.workerIngressPacingIndependentOfAck=false;},
  f=>{f.manifest.ratePacingIsSerialAppend=true;f.offers=undefined;},
  f=>{f.manifest.offeredPacingIndependentOfAck=false;},
  f=>{f.offers.pop();},
  f=>{f.offers[18].status='backpressure-refused';},
  f=>{f.ingest.pop();},
  f=>{f.ingest[5].status='backpressure-refused';},
  f=>{f.manifest.stage.workerIngressAccepted=999;},
  f=>{f.manifest.stage.durableDrain.durableDelivered=999;},
  f=>{f.source[4].sourceSequence=f.source[3].sourceSequence;},
  f=>{f.ei[611].matchToWakeMs=123;},
  f=>{f.host[8].runtimeReceiptId=f.host[7].runtimeReceiptId;},
  f=>{f.originalSequenceById.delete(f.source[10].eventId);},
 ];
 for(const mutate of attacks){
  const f=largeFixture();
  mutate(f);
  assert.throws(()=>assessProgressiveE47CStage(f));
 }
});

test('v3 independent validator accepts bounded max 20 and rejects 21',()=>{
 const f=largeFixture();
 f.manifest.stage.workerIngressMaxInflight=20;
 const accepted=assessProgressiveE47CStage(f);
 assert.equal(accepted.eventCount,1000);
 assert.equal(accepted.productionSloCertified,false);
 f.manifest.stage.workerIngressMaxInflight=21;
 assert.throws(()=>assessProgressiveE47CStage(f));
});
