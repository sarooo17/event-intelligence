import test from 'node:test';
import assert from 'node:assert/strict';
import {assessLiveE47CPilot} from '../scripts/validation/e47c-independent-pilot-recheck.mjs';

const fixture=()=>{
 const source=[],host=[],ei=[],originalEvents=[];
 for(let i=0;i<10;i++){
  const eventId='e47c-e-'+i,wakeId='wake-'+i,receiptId='receipt-'+i;
  source.push({eventId,occurredAt:'2026-11-02T19:35:40.000Z',slot:i});
  host.push({eventId,wakeId,runtimeReceiptId:receiptId,attemptCount:1});
  ei.push({eventId,wakeId,runtimeReceiptId:receiptId,
   workerId:i%2===0?'worker-a':'worker-b',
   ingestToMatchMs:4,matchToWakeMs:5,workerRequestToHostReceiptMs:10});
  originalEvents.push({eventId,name:'example.changed',
   timestamp:'2026-11-02T19:35:40.000Z',data:{slot:i}});
 }
 return {manifest:{schema:'ei.e47c.live-pilot.v1',
   acceptanceE47CVerified:false,productionSloCertified:false,
   stage:{sourceOracleVerified:true,hostDbSharedWithEI:true,events:10,
    triggers:10,observed:10,hostWakeReceipts:10,duplicateHostEffects:0,
    sourceEventLogSha256:'a'.repeat(64),
    workerRequestToHostReceiptMs:{p50:10,p95:10,p99:10}}},
  source,host,ei,originalEvents};
};
test('consistent signed-source/host/worker samples are remeasured but not certified',()=>{
 const r=assessLiveE47CPilot(fixture());
 assert.equal(r.status,'raw-consistent-first-party-staging-only');
 assert.equal(r.eventCount,10);
 assert.equal(r.distinctEIWorkers,2);
 assert.equal(r.hostReceipts,10);
 assert.equal(r.latency.matchToWake.p99,5);
 assert.equal(r.acceptanceE47CVerified,false);
 assert.equal(r.productionSloCertified,false);
});
test('forged receipt, source timestamp/payload, false p99 and censored sample fail',()=>{
 for(const mutate of [
  f=>{f.host[0].runtimeReceiptId='forged-receipt';},
  f=>{f.source[0].occurredAt='2000-01-01T00:00:00.000Z';},
  f=>{f.originalEvents[0].data.slot=600;},
  f=>{f.manifest.stage.workerRequestToHostReceiptMs.p99=1;},
  f=>{f.ei.pop();},
  f=>{f.ei[0].workerId=f.ei[1].workerId;f.ei.forEach(r=>r.workerId='worker-a');},
  f=>{f.ei[0].workerRequestToHostReceiptMs=-1;},
  f=>{f.manifest.productionSloCertified=true;},
 ]){
  const f=fixture();mutate(f);
  assert.throws(()=>assessLiveE47CPilot(f));
 }
});
test('cross-event duplicate wake IDs, receipt IDs and source IDs fail closed',()=>{
 for(const key of ['wakeId','runtimeReceiptId','eventId']){
  const f=fixture();
  f.ei[0][key]=f.ei[1][key];
  assert.throws(()=>assessLiveE47CPilot(f));
 }
});
