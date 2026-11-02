// E47-C live private MCP source -> 2 EI workers -> separately deployed host
// PILOT ONLY: bounded small cohort. Not a 1k/10k/100k multi-rate certification.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import pg from 'pg';
import {performance} from 'node:perf_hooks';
import {PostgresEventStore} from '../lib/postgres-event-store.mjs';
import {parsePrivateServiceUrl} from './common.mjs';
import {verifyStandaloneOracle} from './standalone-mcp-source-oracle.mjs';
import {verifyLiveFiredSourceLineage} from './verify-live-source-lineage.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const required=(env,k)=>{if(!env[k])throw Error('E47C_MISSING_'+k);return env[k];};
export function pilotConfig(env){
 const count=Number(env.EI_E47C_PILOT_EVENTS??10);
 const triggers=Number(env.EI_E47C_PILOT_TRIGGERS??10);
 const delayMs=Number(env.EI_E47C_PILOT_EVENT_DELAY_MS??100);
 if(!Number.isSafeInteger(count)||count<2||count>25||
    !Number.isSafeInteger(triggers)||triggers<count||triggers>1000||
    !Number.isSafeInteger(delayMs)||delayMs<0||delayMs>5000)
  throw Error('E47C_PILOT_LIMIT_EXCEEDED');
 const dir=required(env,'EI_E47C_ARTIFACT_DIR');
 if(!isAbsolute(dir)||dir==='/'||dir.startsWith('/tmp'))
  throw Error('E47C_REQUIRE_PRIVATE_DURABLE_ARTIFACT_DIR');
 const sourceSha=required(env,'EI_E47C_SOURCE_SHA');
 if(!/^[0-9a-f]{40}$/.test(sourceSha))throw Error('E47C_SOURCE_SHA_REQUIRED');
 return {
  count,triggers,delayMs,dir,sourceSha,
  source:parsePrivateServiceUrl(required(env,'EI_LIVE_SOURCE_URL'),'EI_LIVE_SOURCE_URL'),
  token:required(env,'EI_LIVE_SOURCE_TOKEN'),
  workerA:parsePrivateServiceUrl(required(env,'EI_LIVE_WORKER_A_URL'),'EI_LIVE_WORKER_A_URL'),
  workerB:parsePrivateServiceUrl(required(env,'EI_LIVE_WORKER_B_URL'),'EI_LIVE_WORKER_B_URL'),
  workerToken:required(env,'EI_LIVE_WORKER_TOKEN'),
  scopeBase:required(env,'EI_LIVE_BASE_SCOPE'),
  databaseUrl:required(env,'DATABASE_URL'),
  tablePrefix:required(env,'EI_TABLE_PREFIX'),
  sourceServerId:required(env,'EI_SOURCE_SERVER_ID'),
  sourceEventName:required(env,'EI_SOURCE_EVENT_NAME'),
  signer:required(env,'EI_SOURCE_TRUSTED_PUBLIC_KEY_PEM').replace(/\\n/g,'\n'),
  signerSha:required(env,'EI_SOURCE_TRUSTED_PUBLIC_KEY_SHA256'),
  oracleExpected:{scopeId:required(env,'EI_SOURCE_SCOPE_ID'),
   sourceKeyDigest:required(env,'EI_SOURCE_KEY_DIGEST'),
   connectionId:required(env,'EI_SOURCE_CONNECTION_ID'),
   serverId:required(env,'EI_SOURCE_SERVER_ID'),
   eventName:required(env,'EI_SOURCE_EVENT_NAME'),
   argumentsCanonical:required(env,'EI_SOURCE_ARGUMENTS_CANONICAL'),
   completenessRevision:1}
 };
}
export function nearestRank(values,q){
 if(!Array.isArray(values)||values.length<1||
    values.some(n=>!Number.isFinite(n)||n<0))throw Error('E47C_INVALID_LATENCY');
 const sorted=[...values].sort((a,b)=>a-b);
 return Math.round(sorted[Math.ceil(q*sorted.length)-1]*1000)/1000;
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function call(base,path,body,token,expectedStatus=200){
 const response=await fetch(base+path,{method:'POST',headers:{
  authorization:'Bearer '+token,'content-type':'application/json'},
  body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const parsed=await response.json().catch(()=>({}));
 if(response.status!==expectedStatus)throw Error('E47C_REQUEST_FAILED_'+path.replace(/\W/g,'_')+'_'+response.status);
 return parsed;
}
async function saveRaw(dir,name,bytes){
 const path=join(dir,name);
 const fd=await open(path,'wx',0o600);
 try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
 return {name,sha256:sha(bytes),bytes:bytes.length};
}
async function main(env=process.env){
 const c=pilotConfig(env);
 if(c.workerA===c.workerB||sha(c.signer)!==c.signerSha)
  throw Error('E47C_WORKERS_OR_SIGNER_PIN_INVALID');
 const runId=randomUUID();
 const scope=c.scopeBase+':'+runId;
 const prefix='ei-e47c-pilot-'+runId;
 const pool=new pg.Pool({connectionString:c.databaseUrl,max:3,
  connectionTimeoutMillis:5000,statement_timeout:15000});
 const evidenceDir=join(c.dir,prefix);
 let inserted=0,appended=0,observed=0,sourceRaw=null;
 const raw={source:[],host:[],ei:[]};
 const elapsed=[];
 try{
  await mkdir(evidenceDir,{recursive:false,mode:0o700});
  await pool.query('SELECT 1');
  const triggers=Array.from({length:c.triggers},(_,i)=>({
   triggerId:prefix+'-'+i,version:'1',
   clauses:[{id:'changed',serverId:c.sourceServerId,
    event:c.sourceEventName,arguments:{},
    where:[{path:'slot',op:'eq',value:i}]}],
   pattern:{version:'2',root:{kind:'event',ref:'changed'}},
   withinMs:60000,lifecycle:{oneShot:false,cooldownMs:0,completeOnGoal:false},
   target:{runtime:'ei-validation-host',kind:'benchmark-task',id:'e47c-'+i}
  }));
  for(let i=0;i<triggers.length;i+=250){
   const res=await call(c.workerA,'/v1/triggers/batch',{
    scopeId:scope,triggers:triggers.slice(i,i+250)},c.workerToken,201);
   if(res.inserted!==Math.min(250,triggers.length-i))throw Error('E47C_TRIGGER_REGISTER_FAILED');
   inserted+=res.inserted;
  }
  const ids=[];
  for(let i=0;i<c.count;i++){
   const eventId='e47c-'+runId+'-'+i;
   const result=await call(c.source,'/control/append',
    {eventId,data:{slot:i,pilotRun:runId}},c.token);
   if(result.accepted!==true)throw Error('E47C_SOURCE_APPEND_REJECTED');
   ids.push(eventId);appended++;
   if(c.delayMs)await sleep(c.delayMs);
  }
  await call(c.source,'/control/seal',{},c.token);
  let cursor='source-v1:0',page=0;
  const wanted=new Set(ids),events=new Map();
  while(events.size<c.count&&page++<500){
   const p=await call(c.source,'/rpc',{jsonrpc:'2.0',id:page,
    method:'events/poll',params:{cursor,maxEvents:256}},c.token);
   if(p.result?.truncated!==false||!Array.isArray(p.result?.events))
    throw Error('E47C_SOURCE_GAP_REFUSAL');
   for(const e of p.result.events)if(wanted.has(e.eventId))events.set(e.eventId,e);
   if(events.size===c.count)break;
   if(p.result.hasMore!==true)break;
   if(!p.result.cursor||p.result.cursor===cursor)throw Error('E47C_CURSOR_STALLED');
   cursor=p.result.cursor;
  }
  if(events.size!==c.count)throw Error('E47C_SOURCE_POLL_MISSING_ACKED_EVENTS');
  for(let i=0;i<c.count;i++){
   const eventId=ids[i],event=events.get(eventId);
   if(event?.data?.slot!==i)throw Error('E47C_SOURCE_SLOT_MISMATCH');
   const worker=i%2?c.workerB:c.workerA,started=performance.now();
   const result=await call(worker,'/v1/events',{
    scopeId:scope,traceId:'trace-'+eventId,serverId:c.sourceServerId,event
   },c.workerToken);
   const duration=performance.now()-started;
   if(result.accepted!==true||result.matched!==1||result.persistedDeliveredWakes!==1||
      !Number.isFinite(result.timings?.ingestToMatchMs)||
      !Array.isArray(result.timings?.matchToWakeSamplesMs)||
      result.timings.matchToWakeSamplesMs.length!==1)
    throw Error('E47C_EI_WAKE_OR_TIMING_MISMATCH');
   elapsed.push(duration);
   raw.ei.push({eventId,workerId:result.workerId,
    ingestToMatchMs:result.timings.ingestToMatchMs,
    matchToWakeMs:result.timings.matchToWakeSamplesMs[0],
    workerRequestToHostReceiptMs:duration});
   observed++;
  }
  const store=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
    tablePrefix:c.tablePrefix,scopeId:scope});
  await store.init();
  const receipts=await pool.query(
   'SELECT wake_id,receipt_id,attempt_count FROM ei_validation_host_receipts WHERE scope_id=$1',
   [scope]);
  if(receipts.rows.length!==c.count)throw Error('E47C_HOST_RECEIPT_MISSING');
  const byWake=new Map(receipts.rows.map(r=>[r.wake_id,r]));
  const wakeSet=new Set(),receiptSet=new Set();
  for(let i=0;i<c.count;i++){
   const eventId=ids[i],triggerId=prefix+'-'+i;
   const matches=await store.listTriggerMatches(triggerId);
   const lineage=verifyLiveFiredSourceLineage({matches,sourceEventId:eventId,
    sourceEventTimestamp:events.get(eventId).timestamp});
   if(lineage.actualFiredMatches!==1)throw Error('E47C_FIRED_LINEAGE_MISMATCH');
   const wakeId=lineage.record.firedWakeId,receipt=byWake.get(wakeId);
   if(!receipt||Number(receipt.attempt_count)!==1||wakeSet.has(wakeId)||
      receiptSet.has(receipt.receipt_id))throw Error('E47C_WAKE_RECEIPT_REPLAY');
   wakeSet.add(wakeId);receiptSet.add(receipt.receipt_id);
   const delivery=await store.getWakeDelivery(wakeId);
   if(delivery?.status!=='delivered'||delivery.runtimeReceiptId!==receipt.receipt_id)
    throw Error('E47C_DURABLE_HOST_RECEIPT_MISMATCH');
   raw.source.push({eventId,occurredAt:events.get(eventId).timestamp,slot:i});
   raw.host.push({eventId,wakeId,runtimeReceiptId:receipt.receipt_id,attemptCount:1});
   raw.ei[i].wakeId=wakeId;raw.ei[i].runtimeReceiptId=receipt.receipt_id;
  }
  const frontier=await call(c.source,'/frontier',{completenessRevision:1},c.token);
  const archive=await call(c.source,'/control/operator-archive',{},c.token);
  const archiveBytes=Buffer.from(archive.base64??'','base64');
  if(archiveBytes.length!==archive.bytes||sha(archiveBytes)!==archive.sha256||
     frontier.sourceLog?.head!==archive.sourceLog?.head||
     frontier.sourceLog?.sequence!==archive.sourceLog?.sequence)
    throw Error('E47C_SOURCE_LOG_ARCHIVE_INVALID');
  const fileArchive=await saveRaw(evidenceDir,'original-source.jsonl',archiveBytes);
  const independent=await verifyStandaloneOracle({
   logPath:join(evidenceDir,'original-source.jsonl'),
   sourceLog:frontier.sourceLog,attestation:frontier.attestation,
   publicKeyPem:c.signer,expected:c.oracleExpected,now:Date.now()
  });
  if(!independent.valid)throw Error('E47C_SOURCE_ORACLE_INVALID');
  for(const id of ids)if(!independent.events.some(e=>e.eventId===id))
   throw Error('E47C_SOURCE_ORACLE_MISSING_EVENT');
  const manifests={};
  for(const [kind,rows] of Object.entries(raw)){
   const bytes=Buffer.from(rows.map(v=>JSON.stringify(v)).join('\n')+'\n');
   manifests[kind]=await saveRaw(evidenceDir,kind+'.jsonl',bytes);
  }
  const report={schema:'ei.e47c.live-pilot.v1',
   sourceCommitSha:c.sourceSha,runId,scopeDigest:sha(scope),
   stage:{triggers:inserted,events:appended,observed,
    independentEIPools:2,sourceFirstPartySeparateService:true,
    hostFirstPartySeparateService:true,hostDbSharedWithEI:true,
    sourceEventLogSha256:fileArchive.sha256,sourceOracleVerified:true,
    hostWakeReceipts:receipts.rows.length,duplicateHostEffects:0,
    workerRequestToHostReceiptMs:{
     p50:nearestRank(elapsed,.5),p95:nearestRank(elapsed,.95),
     p99:nearestRank(elapsed,.99)}},
   rawManifest:manifests,
   acceptanceE47CVerified:false,productionSloCertified:false,
   limitations:['pilot-event-count-below-1000','single-trigger-cardinality',
    'no-two-rate-high-cardinality-campaign','shared-host-ei-postgres',
    'no-independent-enterprise-security-or-physical-db-io-signoff']};
  const reportBytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
  const saved=await saveRaw(evidenceDir,'pilot-manifest.json',reportBytes);
  console.log(JSON.stringify({event:'ei_e47c_source_linked_live_pilot',
   status:'passed',runId,artifactSha256:saved.sha256,
   sourceLogSha256:fileArchive.sha256,eventCount:observed,
   twoWorkers:true,hostReceipts:receipts.rows.length,
   productionSloCertified:false,acceptanceE47CVerified:false}));
 }catch(e){
  console.error(JSON.stringify({event:'ei_e47c_source_linked_live_pilot',
   status:'failed',code:String(e?.message??'unknown').slice(0,110),
   runId,inserted,appended,observed,
   acceptanceE47CVerified:false,productionSloCertified:false}));
  process.exitCode=1;
 }finally{await pool.end().catch(()=>{});}
}
if(import.meta.url==='file://'+process.argv[1])await main();
