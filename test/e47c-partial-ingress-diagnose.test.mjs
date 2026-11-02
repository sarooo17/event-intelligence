import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeFailedWorkerIngress,parseLines} from
 '../scripts/validation/e47c-partial-ingress-diagnose.mjs';
import {scheduleBoundedWorkerIngress} from
 '../scripts/validation/e47c-bounded-worker-ingress.mjs';

const runId='a21f3548-569f-42b6-9e38-e265d699d758';
function fixture(){
 const offers=[],ingest=[],ei=[];
 for(let i=0;i<50;i++){
  const eventId='e47c-'+runId+'-'+i;
  const workerId=i%2?'ei-worker-b':'ei-worker-a';
  offers.push({index:i,eventId,status:'accepted'});
  const status=i===8?'failed':i===31?'backpressure-refused':'accepted';
  ingest.push({index:i,eventId,workerId,status,
   ...(i===8?{errorCode:'E47C_WORKER_INGRESS_ACK_INVALID'}:{})});
  if(status==='accepted')ei[i]={eventId,workerId};
 }
 const manifest={runId,status:'failed',
  errorCode:'E47C_WORKER_INGRESS_BACKPRESSURE_OR_ACK_FAILURE',
  acceptanceE47CVerified:false,productionSloCertified:false,
  inserted:1000,appended:50,observed:48,
  ingestMetrics:{workerIds:['ei-worker-a','ei-worker-b'],
   accepted:48,rejected:2}};
 return {manifest,offers,ingest,ei};
}
test('diagnostic recovers sparse producer EI artifacts with blank lines',()=>{
 const f=fixture();
 // Same exact serialization as runner's partial artifact saveRaw:
 const bytes=f.ei.map(x=>JSON.stringify(x)).join('\n')+'\n';
 assert.ok(bytes.includes('\n\n'));
 const parsed=parseLines(bytes,250,true);
 assert.equal(parsed.length,50);
 assert.equal(parsed[8],null);
 assert.equal(parsed[31],null);
 const d=summarizeFailedWorkerIngress({...f,ei:parsed});
 assert.equal(d.failureCount,2);
 assert.deepEqual(d.failedRequests.map(x=>x.index),[8,31]);
 assert.equal(d.workerWakeAcknowledged,48);
 assert.equal(d.statusCounts.failed,1);
 assert.equal(d.statusCounts.backpressureRefused,1);
 assert.equal(d.fromPrivateMutableVolume,true);
 assert.equal(d.verifiedOutOfBand,false);
 assert.equal(d.productionSloCertified,false);
 assert.ok(!JSON.stringify(d).includes(runId));
 assert.ok(!JSON.stringify(d).includes('ei-worker-'));
});
test('diagnostic refuses passed outcomes and unrelated source or EI identities',()=>{
 const attacks=[
  f=>{f.manifest.status='passed';},
  f=>{f.manifest.inserted=10000;},
  f=>{f.manifest.observed=49;},
  f=>{f.manifest.ingestMetrics.accepted=49;},
  f=>{f.manifest.ingestMetrics.rejected=1;},
  f=>{f.ei.splice(0,1);},
  f=>{f.ingest.pop();},
  f=>{f.offers.pop();},
  f=>{f.ingest[1].index=0;},
  f=>{f.ingest[0].eventId='cross-run';},
  f=>{f.offers[0].eventId='cross-run';},
  f=>{f.ei[0].eventId='cross-run';},
  f=>{f.ei[0].workerId='ei-worker-b';},
  f=>{f.ei[8]={eventId:f.ingest[8].eventId,workerId:'ei-worker-a'};},
  f=>{f.ingest[0].status='invented';},
  f=>{f.manifest.productionSloCertified=true;},
 ];
 for(const attack of attacks){const f=fixture();attack(f);
  assert.throws(()=>summarizeFailedWorkerIngress(f));}
});
test('diagnostic categorizes errors via fixed allowlist and only worker aliases',()=>{
 const f=fixture();
 f.ingest[8].errorCode='E47C_SECRET_RICCARDO_1234';
 const d=summarizeFailedWorkerIngress(f);
 assert.equal(d.failedRequests[0].category,'unknown-error');
 assert.equal(d.failedRequests[0].worker,'worker-0');
 assert.ok(!JSON.stringify(d).includes('SECRET_RICCARDO'));
 const g=fixture();g.ingest[8].errorCode='E47C_SOURCE_SEND_FAILED';
 const x=summarizeFailedWorkerIngress(g);
 assert.equal(x.failedRequests[0].category,'unknown-worker-send-failure');
});
test('sparse parser rejects unbounded and malformed artifacts',()=>{
 assert.throws(()=>parseLines('garbage\n',250,true));
 assert.throws(()=>parseLines('{"a":1}',250,true));
 assert.throws(()=>parseLines('\n',250,false));
 assert.throws(()=>parseLines(Array(252).fill('{}').join('\n')+'\n',250,true));
});


test('all worker requests failed: zero ACKs means runner omitted partial-ei.jsonl',()=>{
 const f=fixture();
 f.ingest.forEach(x=>{x.status='failed';x.errorCode='E47C_WORKER_INGRESS_ACK_INVALID';});
 f.ei=[]; // runner has NO partial-ei file in this case
 f.manifest.observed=0;
 f.manifest.ingestMetrics.accepted=0;
 f.manifest.ingestMetrics.rejected=50;
 const diag=summarizeFailedWorkerIngress(f);
 assert.equal(diag.workerWakeAcknowledged,0);
 assert.equal(diag.failureCount,50);
 assert.equal(diag.statusCounts.failed,50);
 assert.equal(diag.statusCounts.accepted,0);
 assert.equal(diag.productionSloCertified,false);
});

// Exercise the actual worker-ingress sanitization. HTTP status codes from
// the request helper are NOT preserved in the prior run's raw evidence.
test('producer redaction cannot be mistaken for a proven transport fault',async()=>{
 let clock=0;
 const job=await scheduleBoundedWorkerIngress({count:2,rate:5,maxInflight:2,
  workerIds:['ei-worker-a','ei-worker-b'],now:()=>clock,
  wait:async ms=>{clock+=ms;},
  send:async()=>{throw Error('E47C_REQUEST_FAILED__v1_events_503');}
 });
 assert.equal(job.rejected,2);
 assert.equal(job.rows[0].errorCode,'E47C_SOURCE_SEND_FAILED');
 const f=fixture();
 f.ingest[8].errorCode=job.rows[0].errorCode;
 assert.equal(summarizeFailedWorkerIngress(f).failedRequests[0].category,
  'unknown-worker-send-failure');
});
