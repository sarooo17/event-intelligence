import test from 'node:test';
import assert from 'node:assert/strict';
import {assessProgressiveE47CStage} from '../scripts/validation/e47c-progressive-1k-recheck.mjs';

function fixture(rate=1){
 const source=[],host=[],ei=[],originalEvents=[];
 for(let i=0;i<50;i++){
  const eventId='e47c-'+i,wakeId='wake-'+i,receipt='receipt-'+i;
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
 },source,host,ei,originalEvents};
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
  f=>{f.host[0].runtimeReceiptId='falsified';},
  f=>{f.manifest.stage.workerRequestToHostReceiptMs.p99=0.1;},
  f=>{f.ei.pop();},
  f=>{f.ei.forEach(v=>v.workerId='worker-a');},
  f=>{f.manifest.acceptanceE47CVerified=true;},
 ];
 for(const attack of attacks){const f=fixture();attack(f);
  assert.throws(()=>assessProgressiveE47CStage(f));}
});
