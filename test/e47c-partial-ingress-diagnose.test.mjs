import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeFailedWorkerIngress} from '../scripts/validation/e47c-partial-ingress-diagnose.mjs';

function make(){
 const ingest=Array.from({length:50},(_,i)=>({
  index:i,workerId:i%2?'ei-b':'ei-a',
  status:i===8?'failed':i===31?'backpressure-refused':'accepted',
  ...(i===8?{errorCode:'E47C_WORKER_INGRESS_ACK_INVALID'}:{}),
 }));
 const ei=ingest.filter(x=>x.status==='accepted').map(x=>({eventId:'e'+x.index}));
 const manifest={status:'failed',
  errorCode:'E47C_WORKER_INGRESS_BACKPRESSURE_OR_ACK_FAILURE',
  acceptanceE47CVerified:false,productionSloCertified:false,
  inserted:1000,appended:50,observed:48};
 return {manifest,ingest,ei};
}
test('diagnostic reports exact failure classes without source payload data',()=>{
 const d=summarizeFailedWorkerIngress(make());
 assert.equal(d.failureCount,2);
 assert.equal(d.statusCounts.accepted,48);
 assert.equal(d.statusCounts.failed,1);
 assert.equal(d.statusCounts.backpressureRefused,1);
 assert.deepEqual(d.failedRequests.map(x=>x.index),[8,31]);
 assert.equal(d.fromPrivateMutableVolume,true);
 assert.equal(d.verifiedOutOfBand,false);
 assert.equal(d.acceptanceE47CVerified,false);
});
test('diagnostic refuses passed or inconsistent fabricated results',()=>{
 const attacks=[
  x=>{x.manifest.status='passed';},
  x=>{x.manifest.inserted=10000;},
  x=>{x.manifest.observed=49;},
  x=>{x.ei.pop();},
  x=>{x.ingest.pop();},
  x=>{x.ingest[0].index=x.ingest[1].index;},
  x=>{x.ingest[0].status='invented';},
  x=>{x.manifest.productionSloCertified=true;},
 ];
 for(const attack of attacks){const x=make();attack(x);
  assert.throws(()=>summarizeFailedWorkerIngress(x));}
});
test('malicious error detail is redacted from public diagnostic',()=>{
 const x=make();
 x.ingest[8].errorCode='Bearer secret-value';
 const d=summarizeFailedWorkerIngress(x);
 assert.equal(d.failedRequests[0].errorCode,'E47C_DIAG_REDACTED');
 assert.ok(!JSON.stringify(d).includes('secret-value'));
});
