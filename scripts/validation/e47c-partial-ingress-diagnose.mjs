// Read-only forensic diagnosis of a *failed* E47-C worker-ingest preflight.
// Evidence from a writable staging volume is diagnostic, not an independent
// production certification or a cryptographically anchored receipt.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

function fail(code){throw Object.assign(new Error(code),{code});}
const safeCode=v=>typeof v==='string'&&/^E47C_[A-Z0-9_]{1,100}$/.test(v);
async function readPrivateFile(path,maxBytes){
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const st=await f.stat();
  if(!st.isFile()||st.size<1||st.size>maxBytes)fail('E47C_DIAG_BOUNDS');
  return await f.readFile({encoding:'utf8'});
 }finally{await f.close();}
}
function parseObject(text){
 let o;
 try{o=JSON.parse(text);}catch{fail('E47C_DIAG_JSON_INVALID');}
 if(!o||typeof o!=='object'||Array.isArray(o))fail('E47C_DIAG_JSON_INVALID');
 return o;
}
function parseLines(text,cap){
 if(!text.endsWith('\n'))fail('E47C_DIAG_TRUNCATED');
 const lines=text.slice(0,-1).split('\n');
 if(lines.length>cap)fail('E47C_DIAG_BOUNDS');
 return lines.map(parseObject);
}
export function summarizeFailedWorkerIngress({manifest,ingest,ei}={}){
 if(manifest?.status!=='failed'||
    manifest?.errorCode!=='E47C_WORKER_INGRESS_BACKPRESSURE_OR_ACK_FAILURE'||
    manifest.acceptanceE47CVerified!==false||
    manifest.productionSloCertified!==false||
    !Number.isSafeInteger(manifest.inserted)||manifest.inserted!==1000||
    !Number.isSafeInteger(manifest.appended)||manifest.appended<10||
    manifest.appended>250||
    !Number.isSafeInteger(manifest.observed)||manifest.observed<0||
    !Array.isArray(ingest)||ingest.length!==manifest.appended||
    !Array.isArray(ei)||ei.length!==manifest.observed)
  fail('E47C_DIAG_NOT_A_BOUNDED_FAILED_CAMPAIGN');
 const statuses={accepted:0,failed:0,backpressureRefused:0};
 const failed=[];
 const indexes=new Set();
 const workers={};
 for(const row of ingest){
  if(!Number.isSafeInteger(row.index)||row.index<0||
     row.index>=manifest.appended||indexes.has(row.index)||
     typeof row.workerId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(row.workerId))
   fail('E47C_DIAG_ROW_INVALID');
  indexes.add(row.index);
  if(row.status==='accepted')statuses.accepted++;
  else if(row.status==='backpressure-refused'){
   statuses.backpressureRefused++;
   failed.push({index:row.index,workerId:row.workerId,
    status:'backpressure-refused'});
  }else if(row.status==='failed'){
   statuses.failed++;
   failed.push({index:row.index,workerId:row.workerId,status:'failed',
    errorCode:safeCode(row.errorCode)?row.errorCode:'E47C_DIAG_REDACTED'});
  }else fail('E47C_DIAG_STATUS_INVALID');
  const key=row.workerId;
  workers[key]??={accepted:0,failed:0,backpressureRefused:0};
  if(row.status==='accepted')workers[key].accepted++;
  else if(row.status==='failed')workers[key].failed++;
  else workers[key].backpressureRefused++;
 }
 if(statuses.accepted!==manifest.observed||
    statuses.accepted+statuses.failed+statuses.backpressureRefused!==manifest.appended)
  fail('E47C_DIAG_COUNTS_DISAGREE');
 failed.sort((a,b)=>a.index-b.index);
 return Object.freeze({
  status:'partial-diagnostic-not-verified',
  fromPrivateMutableVolume:true,verifiedOutOfBand:false,
  acceptanceE47CVerified:false,productionSloCertified:false,
  inserted:manifest.inserted,sourceAppended:manifest.appended,
  workerWakeAcknowledged:manifest.observed,
  statusCounts:statuses,workerCounts:workers,
  failedRequests:failed.slice(0,30),
  failureCount:failed.length,
  boundedCampaign:true
 });
}
export async function inspectFailedWorkerIngress({dir,runId,rate}={}){
 if(!isAbsolute(dir)||dir==='/'||dir.startsWith('/tmp')||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId??'')||
    ![1,5].includes(rate))fail('E47C_DIAG_CONFIG_INVALID');
 const folder=join(dir,'ei-e47c-progressive-1k-r'+rate+'-'+runId);
 const manifest=parseObject(await readPrivateFile(join(folder,'partial-manifest.json'),1024*1024));
 if(manifest.runId!==runId)fail('E47C_DIAG_RUN_ID_MISMATCH');
 const ingest=parseLines(await readPrivateFile(join(folder,'partial-ingest.jsonl'),2*1024*1024),250);
 const ei=parseLines(await readPrivateFile(join(folder,'partial-ei.jsonl'),2*1024*1024),250);
 return {...summarizeFailedWorkerIngress({manifest,ingest,ei}),runId};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const diag=await inspectFailedWorkerIngress({
   dir:process.env.EI_E47C_ARTIFACT_DIR,
   runId:process.env.EI_E47C_PILOT_RUN_ID,
   rate:Number(process.env.EI_E47C_STAGE_RATE)
  });
  console.log(JSON.stringify({event:'e47c_failed_worker_ingress_diagnosis',...diag}));
 }catch(e){
  console.error(JSON.stringify({event:'e47c_failed_worker_ingress_diagnosis',
   status:'blocked',code:safeCode(e?.code)?e.code:'E47C_DIAG_REDACTED',
   productionSloCertified:false,acceptanceE47CVerified:false}));
  process.exitCode=1;
 }
}
