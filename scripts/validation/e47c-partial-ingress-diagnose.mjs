// Read-only diagnosis of a FAILED E47-C first-party staging campaign.
// Mutable operator volume: NOT independently anchored evidence/certification.
// Linux /proc/self/fd directory handles keep reads confined to the opened
// run directory, even if the path is swapped after the directory is opened.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const fail=(code)=>{throw Object.assign(new Error(code),{code});};
const safeId=v=>typeof v==='string'&&/^[a-z0-9-]{36}$/.test(v);
const errorCategory=code=>{
 if(code==='E47C_WORKER_INGRESS_ACK_INVALID')return 'invalid-worker-ack';
 if(code==='E47C_WORKER_ACK_NOT_ACCEPTED')return 'worker-not-accepted';
 if(code==='E47C_WORKER_ACK_IDENTITY_MISMATCH')return 'worker-identity-mismatch';
 if(code==='E47C_WORKER_ACK_MATCH_COUNT_INVALID')return 'worker-match-count-invalid';
 if(code==='E47C_WORKER_ACK_IMMEDIATE_DELIVERY_MISSING')return 'immediate-delivery-not-proven';
 if(code==='E47C_WORKER_ACK_INGEST_TIMING_INVALID')return 'ingest-timing-invalid';
 if(code==='E47C_WORKER_ACK_WAKE_TIMING_INVALID')return 'wake-timing-invalid';
 // The source runner collapses HTTP errors and transport failures to this
 // generic saved code. It does NOT identify the underlying failure mode.
 if(code==='E47C_SOURCE_SEND_FAILED')return 'unknown-worker-send-failure';
 if(code==='E47C_BAD_MONOTONIC_CLOCK')return 'clock-error';
 return 'unknown-error';
};
async function readBoundedFromDirectory(dirHandle,name,maxBytes){
 if(!/^partial-(?:manifest\.json|(?:offer|ingest|ei)\.jsonl)$/.test(name))
  fail('E47C_DIAG_UNEXPECTED_FILE');
 const handle=await open('/proc/self/fd/'+dirHandle.fd+'/'+name,
  constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=await handle.stat();
  if(!stat.isFile()||stat.size<1||stat.size>maxBytes)
   fail('E47C_DIAG_ARTIFACT_BOUNDS');
  const chunks=[];let total=0;
  while(total<=maxBytes){
   const buffer=Buffer.alloc(Math.min(65536,maxBytes+1-total));
   const {bytesRead}=await handle.read(buffer,0,buffer.length,null);
   if(!bytesRead)break;
   total+=bytesRead;chunks.push(buffer.subarray(0,bytesRead));
  }
  if(total>maxBytes)fail('E47C_DIAG_ARTIFACT_BOUNDS');
  const after=await handle.stat();
  if(after.size!==stat.size||total!==stat.size)
   fail('E47C_DIAG_CONCURRENT_ARTIFACT_CHANGE');
  return Buffer.concat(chunks,total).toString('utf8');
 }finally{await handle.close();}
}
function parseObject(text){
 let o;try{o=JSON.parse(text);}catch{fail('E47C_DIAG_JSON_INVALID');}
 if(!o||typeof o!=='object'||Array.isArray(o))fail('E47C_DIAG_JSON_INVALID');
 return o;
}
export function parseLines(text,cap,allowSparse=false){
 if(!text.endsWith('\n')||text.includes('\r'))
  fail('E47C_DIAG_TRUNCATED');
 const lines=text.slice(0,-1).split('\n');
 if(lines.length>cap)fail('E47C_DIAG_BOUNDS');
 return lines.map(line=>line?parseObject(line):allowSparse?null:fail('E47C_DIAG_JSON_INVALID'));
}
export function summarizeFailedWorkerIngress({manifest,offers,ingest,ei}={}){
 const runId=manifest?.runId,count=manifest?.appended;
 if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(runId??'')||
    manifest.status!=='failed'||
    manifest.errorCode!=='E47C_WORKER_INGRESS_BACKPRESSURE_OR_ACK_FAILURE'||
    manifest.acceptanceE47CVerified!==false||
    manifest.productionSloCertified!==false||
    manifest.inserted!==1000||
    !Number.isSafeInteger(count)||count<10||count>250||
    !Number.isSafeInteger(manifest.observed)||manifest.observed<0||
    !Array.isArray(offers)||offers.length!==count||
    !Array.isArray(ingest)||ingest.length!==count||
    !Array.isArray(ei)||ei.length>count||
    !Array.isArray(manifest.ingestMetrics?.workerIds)||
    manifest.ingestMetrics.workerIds.length!==2||
    manifest.ingestMetrics.workerIds.some(w=>typeof w!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(w))||
    manifest.ingestMetrics.workerIds[0]===manifest.ingestMetrics.workerIds[1])
  fail('E47C_DIAG_NOT_BOUNDED_FAILED_CAMPAIGN');
 const workers=manifest.ingestMetrics.workerIds;
 const counts={accepted:0,failed:0,backpressureRefused:0};
 const workerCounts={'worker-0':{accepted:0,failed:0,backpressureRefused:0},
  'worker-1':{accepted:0,failed:0,backpressureRefused:0}};
 const failures=[];
 for(let i=0;i<count;i++){
  const expectedEventId='e47c-'+runId+'-'+i;
  const offer=offers[i],row=ingest[i],ack=ei[i]??null;
  if(offer?.index!==i||offer.eventId!==expectedEventId||
     offer.status!=='accepted'||
     row?.index!==i||row.eventId!==expectedEventId||
     row.workerId!==workers[i%2])
   fail('E47C_DIAG_SOURCE_WORKER_LINEAGE_MISMATCH');
  const alias='worker-'+(i%2);
  if(row.status==='accepted'){
   counts.accepted++;workerCounts[alias].accepted++;
   if(ack?.eventId!==expectedEventId||ack.workerId!==workers[i%2])
    fail('E47C_DIAG_MISSING_OR_UNRELATED_EI_ACK');
  }else if(row.status==='failed'||row.status==='backpressure-refused'){
   if(ack!==null)fail('E47C_DIAG_UNEXPECTED_EI_ACK');
   if(row.status==='failed'){
    counts.failed++;workerCounts[alias].failed++;
    failures.push({index:i,worker:alias,status:'failed',
     category:errorCategory(row.errorCode)});
   }else{
    counts.backpressureRefused++;workerCounts[alias].backpressureRefused++;
    failures.push({index:i,worker:alias,status:'backpressure-refused'});
   }
  }else fail('E47C_DIAG_STATUS_INVALID');
 }
 if(counts.accepted!==manifest.observed||
    counts.accepted!==manifest.ingestMetrics.accepted||
    counts.failed+counts.backpressureRefused!==manifest.ingestMetrics.rejected||
    counts.accepted+counts.failed+counts.backpressureRefused!==count)
  fail('E47C_DIAG_COUNTS_DISAGREE');
 return Object.freeze({
  status:'partial-diagnostic-not-verified',
  fromPrivateMutableVolume:true,verifiedOutOfBand:false,
  acceptanceE47CVerified:false,productionSloCertified:false,
  triggers:1000,sourceAppended:count,
  workerWakeAcknowledged:manifest.observed,
  statusCounts:counts,workerCounts,
  failedRequests:failures.slice(0,30),
  failureCount:failures.length,
  boundedCampaign:true
 });
}
export async function inspectFailedWorkerIngress({dir,runId,rate}={}){
 // This operator-only tool is deliberately scoped to the existing
 // known private Railway volume mounted directly off root.
 if(dir!=='/evidence'||!safeId(runId)||![1,5].includes(rate))
  fail('E47C_DIAG_CONFIG_INVALID');
 const root=await open(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try{
  const folder='ei-e47c-progressive-1k-r'+rate+'-'+runId;
  const child=await open('/proc/self/fd/'+root.fd+'/'+folder,
   constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{
   const manifest=parseObject(await readBoundedFromDirectory(child,'partial-manifest.json',1024*1024));
   if(manifest.runId!==runId)fail('E47C_DIAG_RUN_ID_MISMATCH');
   const offers=parseLines(await readBoundedFromDirectory(child,'partial-offer.jsonl',2*1024*1024),250);
   const ingest=parseLines(await readBoundedFromDirectory(child,'partial-ingest.jsonl',2*1024*1024),250);
   // The runner deliberately omits the partial EI file if no worker
   // ACK ever succeeded. Allow that ONLY for an explicitly zero-ACK
   // manifest. Any missing artifact with positive ACKs still fails.
   const eiText=await readBoundedFromDirectory(
    child,'partial-ei.jsonl',2*1024*1024).catch(err=>{
    if(err?.code==='ENOENT'&&manifest.observed===0)return null;
    throw err;
   });
   const ei=eiText===null?[]:parseLines(eiText,250,true);
   return summarizeFailedWorkerIngress({manifest,offers,ingest,ei});
  }finally{await child.close();}
 }finally{await root.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const diag=await inspectFailedWorkerIngress({
   dir:process.env.EI_E47C_ARTIFACT_DIR,
   runId:process.env.EI_E47C_PILOT_RUN_ID,
   rate:Number(process.env.EI_E47C_STAGE_RATE),
  });
  console.log(JSON.stringify({event:'e47c_failed_worker_ingress_diagnosis',...diag}));
 }catch(e){
  console.error(JSON.stringify({event:'e47c_failed_worker_ingress_diagnosis',
   status:'blocked',code:/^E47C_DIAG_[A-Z0-9_]+$/.test(e?.code??'')?
    e.code:'E47C_DIAG_REDACTED',
   productionSloCertified:false,acceptanceE47CVerified:false}));
  process.exitCode=1;
 }
}
