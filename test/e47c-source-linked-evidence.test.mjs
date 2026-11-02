import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectE47CArtifactDirectory} from '../scripts/validation/e47c-evidence-cli.mjs';
import {assessE47CSourceLinkedEvidence,E47C_SCHEMA} from '../scripts/validation/e47c-source-linked-evidence.mjs';

const digest=s=>createHash('sha256').update(s).digest('hex');
const stageKey=(count,rate)=>count+'_'+rate;
function fixture(){
 const files={},stages=[];
 for(const triggerCount of [1000,10000,100000]){
  for(const requestedRatePerSecond of [1,10]){
   const id=stageKey(triggerCount,requestedRatePerSecond);
   const source=[],host=[],ei=[];
   for(let i=1;i<=1000;i++){
    const eventId='source_'+id+'_event_'+i;
    const wakeId='wake_'+id+'_'+i, runtimeReceiptId='receipt_'+id+'_'+i;
    source.push({eventId,sourceSequence:i});
    host.push({eventId,wakeId,runtimeReceiptId});
    ei.push({eventId,wakeId,runtimeReceiptId,workerId:i%2?'worker-a':'worker-b',
      ingestToMatchMs:7,matchToWakeMs:12,endToEndMs:25});
   }
   const insert=(kind,rows)=>{
    const file=kind+'-'+id+'.jsonl',content=rows.map(v=>JSON.stringify(v)).join('\n')+'\n';
    files[file]=content;return {file,sha256:digest(content)};
   };
   stages.push({triggerCount,requestedRatePerSecond,durationSeconds:600,
    expectedEventCount:1000,sourceRaw:insert('source',source),
    hostRaw:insert('host',host),eiRaw:insert('ei',ei),
    postgres:{cpuUserMicros:11,ioReadBlocks:0,ioHitBlocks:90,storageBytes:2000},
    rssPeakBytes:50000,duplicateHostEffects:0,unsettledWakeCount:0,
    latency:{ingestToMatch:{p50:7,p95:7,p99:7},
      matchToWake:{p50:12,p95:12,p99:12},
      endToEnd:{p50:25,p95:25,p99:25}}});
  }
 }
 return {files,manifest:{schema:E47C_SCHEMA,sourceCommitSha:'a'.repeat(40),
  provider:{kind:'deployed-mcp-events-source',serviceId:'separate-source',
    deploymentId:'source-deploy',oracleSourceLogSha256:'b'.repeat(64)},
  host:{kind:'separately-deployed-host',serviceId:'separate-host',
    deploymentId:'host-deploy'},
  workers:[{id:'worker-a',serviceId:'ei-a',deploymentId:'worker-a-deploy'},
   {id:'worker-b',serviceId:'ei-b',deploymentId:'worker-b-deploy'}],
  stages}};
}
function mutate(stage,kind,files,mutateRows){
 const ref=stage[kind+'Raw'],rows=files[ref.file].trimEnd().split('\n').map(x=>JSON.parse(x));
 mutateRows(rows);
 files[ref.file]=rows.map(x=>JSON.stringify(x)).join('\n')+'\n';
 ref.sha256=digest(files[ref.file]);
}
test('raw 1k/10k/100k two-rate lineage, durations and p99 are recomputed, never certified',()=>{
 const f=fixture(), result=assessE47CSourceLinkedEvidence(f);
 assert.equal(result.status,'consistent-requires-independent-review',result.missing.join(','));
 assert.equal(result.missing.length,0);
 assert.equal(result.stageEvidence.length,6);
 assert.equal(result.acceptanceVerified,false);
 assert.equal(result.productionSloCertified,false);
 assert.equal(result.sourceAuthenticityIndependentlyAttested,false);
});
test('truncated/tampered artifact is blocked even with good summary',()=>{
 const f=fixture(),stage=f.manifest.stages[0];
 f.files[stage.hostRaw.file]+='{}\n';
 const result=assessE47CSourceLinkedEvidence(f);
 assert.ok(result.missing.some(x=>x.includes('artifact-bytes-or-sha256-mismatch')));
});
test('censored sample, missing source and extra host each fail independently',()=>{
 for(const kind of ['ei','source','host']){
  const f=fixture(),stage=f.manifest.stages[0];
  mutate(stage,kind,f.files,rows=>rows.pop());
  const r=assessE47CSourceLinkedEvidence(f);
  assert.equal(r.status,'blocked',kind);
  assert.ok(r.missing.some(x=>x.includes('raw-row-count')),kind);
 }
});
test('host-receipt association mismatch, double receipt, one worker and p99 false claims fail closed',()=>{
 for(const fail of ['association','double','worker','p99']){
  const f=fixture(),stage=f.manifest.stages[0];
  if(fail==='association')mutate(stage,'host',f.files,r=>{r[0].wakeId='forged';});
  if(fail==='double')mutate(stage,'host',f.files,r=>{r[0].runtimeReceiptId=r[1].runtimeReceiptId;});
  if(fail==='worker')mutate(stage,'ei',f.files,r=>{r.forEach(x=>x.workerId='worker-a');});
  if(fail==='p99')stage.latency.endToEnd.p99=0.01;
  const result=assessE47CSourceLinkedEvidence(f);
  assert.equal(result.status,'blocked',fail);
  assert.ok(result.missing.some(x=>x.includes({
   association:'source-ei-host-lineage-disagreement',
   double:'invalid-or-duplicate-host-receipt',
   worker:'no-two-distinct-worker-observations',
   p99:'incorrect-or-censored-p99'}[fail])),fail);
 }
});
test('fake independent provider, reused failure domain, missing two rates and poisoned provenance fail',()=>{
 for(const mutation of [
  m=>m.provider.kind='synthetic-mcp-shaped-in-benchmark-host',
  m=>m.host.serviceId=m.provider.serviceId,
  m=>m.stages.pop(),
  m=>m.sourceCommitSha='untrusted',
 ]){
  const f=fixture();mutation(f.manifest);
  assert.equal(assessE47CSourceLinkedEvidence(f).status,'blocked');
 }
});
test('missing/raw invalid files reject path escapes or hash-only invented source data',()=>{
 const f=fixture();f.manifest.stages[0].sourceRaw.file='../exfiltrate.jsonl';
 assert.equal(assessE47CSourceLinkedEvidence(f).status,'blocked');
 const other=fixture();
 other.files[other.manifest.stages[0].sourceRaw.file]='{}\n';
 assert.equal(assessE47CSourceLinkedEvidence(other).status,'blocked');
});
test('no fabricated approval with empty or malformed report',()=>{
 for(const v of [null,{}, {schema:E47C_SCHEMA}, {schema:E47C_SCHEMA,stages:[]}])
  assert.equal(assessE47CSourceLinkedEvidence({manifest:v,files:{}}).status,'blocked');
});

test('private artifact CLI rejects symlinked manifest and original raw files',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ei-e47c-'));
 try{
  const f=fixture();
  const first=f.manifest.stages[0].sourceRaw.file;
  const outer=join(directory,'original.jsonl');
  await writeFile(outer,f.files[first]);
  await writeFile(join(directory,'manifest.json'),JSON.stringify(f.manifest));
  await symlink(outer,join(directory,first));
  await assert.rejects(inspectE47CArtifactDirectory(directory));
  await rm(join(directory,first));
  await rm(join(directory,'manifest.json'));
  await symlink(outer,join(directory,'manifest.json'));
  await assert.rejects(inspectE47CArtifactDirectory(directory));
 }finally{await rm(directory,{recursive:true,force:true});}
});
