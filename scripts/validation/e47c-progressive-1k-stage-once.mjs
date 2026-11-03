// E47-C live private MCP source -> 2 EI workers -> separately deployed host
// PROGRESSIVE STAGE ONLY: 1,000 durable triggers x 1 or 5 offered-event/s; not full E47-C.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,statfs} from 'node:fs/promises';
import {join,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {performance} from 'node:perf_hooks';
import {PostgresEventStore} from '../lib/postgres-event-store.mjs';
import {parsePrivateServiceUrl} from './common.mjs';
import {verifyStandaloneOracle} from './standalone-mcp-source-oracle.mjs';
import {verifyLiveFiredSourceLineage} from './verify-live-source-lineage.mjs';
import {scheduleBoundedSourceOffers} from './e47c-open-loop-pacing.mjs';
import {scheduleBoundedWorkerIngress} from './e47c-bounded-worker-ingress.mjs';
import {waitForDurableReceiptCount} from './e47c-durable-ack-drain.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const required=(env,k)=>{if(!env[k])throw Error('E47C_MISSING_'+k);return env[k];};
export function progressiveConfig(env){
 const large=env.EI_E47C_STAGE_CONFIRM==='RUN_1000_EVENTS_FIRST_PARTY_STAGING';
 if(!large&&env.EI_E47C_STAGE_CONFIRM!=='RUN_1000_FIRST_PARTY_STAGING')
  throw Error('E47C_STAGE_EXPLICIT_OPT_IN_REQUIRED');
 const rate=Number(env.EI_E47C_STAGE_RATE);
 if(![1,5].includes(rate))throw Error('E47C_UNSUPPORTED_STAGE_RATE');
 const count=Number(env.EI_E47C_STAGE_EVENTS??50);
 const triggers=1000;
 const delayMs=1000/rate;
 const maxInflight=Number(env.EI_E47C_MAX_INFLIGHT??4);
 const workerInflight=Number(env.EI_E47C_WORKER_MAX_INFLIGHT??4);
 const deliveryMode=env.EI_E47C_DELIVERY_MODE??'immediate';
 const drainTimeoutMs=Number(env.EI_E47C_DURABLE_DRAIN_MS??30000);
 if(!Number.isSafeInteger(count)||count<10||
    (large?count!==1000:count>250)||
    (large&&deliveryMode!=='eventual')||
    !Number.isSafeInteger(triggers)||triggers<count||triggers>1000||
    !Number.isSafeInteger(delayMs)||delayMs<0||delayMs>5000||
    !Number.isSafeInteger(maxInflight)||maxInflight<1||maxInflight>8||
    !Number.isSafeInteger(workerInflight)||workerInflight<1||
    workerInflight>(large?20:8)||
    !['immediate','eventual'].includes(deliveryMode)||
    !Number.isSafeInteger(drainTimeoutMs)||drainTimeoutMs<1000||
    drainTimeoutMs>120000)
  throw Error('E47C_PILOT_LIMIT_EXCEEDED');
 const dir=required(env,'EI_E47C_ARTIFACT_DIR');
 if(!isAbsolute(dir)||dir==='/'||dir.startsWith('/tmp'))
  throw Error('E47C_REQUIRE_PRIVATE_DURABLE_ARTIFACT_DIR');
 const sourceSha=required(env,'EI_E47C_SOURCE_SHA');
 if(!/^[0-9a-f]{40}$/.test(sourceSha))throw Error('E47C_SOURCE_SHA_REQUIRED');
 return {
  count,triggers,delayMs,rate,maxInflight,workerInflight,deliveryMode,large,
  drainTimeoutMs,dir,sourceSha,
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
async function call(base,path,body,token,expectedStatus=200){
 const response=await fetch(base+path,{method:'POST',headers:{
  authorization:'Bearer '+token,'content-type':'application/json'},
  body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const parsed=await response.json().catch(()=>({}));
 if(response.status!==expectedStatus)throw Error('E47C_REQUEST_FAILED_'+path.replace(/\W/g,'_')+'_'+response.status);
 return parsed;
}
// Check separate real EI worker identities via read-only, private-network
// readiness endpoints BEFORE inserting any 1k trigger or source event.
export async function preflightLargeWorkers({workerA,workerB,request=fetch}={}){
 if(typeof request!=='function')
  throw Error('E47C_LARGE_WORKER_PREFLIGHT_CONFIG_INVALID');
 const urls=[
  parsePrivateServiceUrl(workerA,'EI_LIVE_WORKER_A_URL'),
  parsePrivateServiceUrl(workerB,'EI_LIVE_WORKER_B_URL')
 ];
 if(urls[0]===urls[1])throw Error('E47C_LARGE_WORKER_ENDPOINT_DUPLICATE');
 const identities=await Promise.all(urls.map(async base=>{
  const response=await request(base+'/readyz',{
   method:'GET',signal:AbortSignal.timeout(5000)
  });
  if(response?.status!==200)throw Error('E47C_LARGE_WORKER_NOT_READY');
  const body=await response.json().catch(()=>({}));
  if(body?.status!=='ready'||typeof body.workerId!=='string'||
     !/^[a-zA-Z0-9_-]{1,128}$/.test(body.workerId))
   throw Error('E47C_LARGE_WORKER_ID_INVALID');
  return body.workerId;
 }));
 if(identities[0]===identities[1])
  throw Error('E47C_LARGE_WORKER_IDENTITY_DUPLICATE');
 return Object.freeze([...identities]);
}

async function saveRaw(dir,name,bytes){
 const path=join(dir,name);
 const fd=await open(path,'wx',0o600);
 try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
 return {name,sha256:sha(bytes),bytes:bytes.length};
}
async function main(env=process.env){
 const c=progressiveConfig(env);
 if(c.workerA===c.workerB||sha(c.signer)!==c.signerSha)
  throw Error('E47C_WORKERS_OR_SIGNER_PIN_INVALID');
 if(!/^[a-z][a-z0-9_]{0,40}$/.test(c.tablePrefix))
  throw Error('E47C_UNSAFE_TABLE_PREFIX');
 const runId=randomUUID();
 const scope=c.scopeBase+':'+runId;
 const prefix='ei-e47c-progressive-1k-r'+c.rate+'-'+runId;
 const pool=new pg.Pool({connectionString:c.databaseUrl,max:3,
  connectionTimeoutMillis:5000,statement_timeout:15000});
 const evidenceDir=join(c.dir,prefix);
 let pinnedLargeWorkerIds=null;
 let inserted=0,appended=0,observed=0,sourceRaw=null;
 const raw={source:[],host:[],ei:[],offer:[],ingest:[]};
 let offerMetrics=null,ingestMetrics=null,durableDrain=null;
 const acknowledgements=new Map();
 const validTiming=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
 const elapsed=[];
 try{
  await mkdir(evidenceDir,{recursive:false,mode:0o700});
  if(c.large){
   // No 1k write begins without a private durable evidence-volume reserve
   // and an independently read-only source log capacity check.
   const fs=await statfs(evidenceDir);
   if(fs.bavail*fs.bsize<32*1024*1024)
    throw Error('E47C_LARGE_EVIDENCE_VOLUME_BUDGET_LOW');
   const archive=await call(c.source,'/control/operator-archive',{},c.token);
   if(!Number.isSafeInteger(archive.bytes)||archive.bytes<1||
      archive.bytes>14*1024*1024||
      typeof archive.sha256!=='string'||!/^([a-f0-9]{64})$/.test(archive.sha256))
    throw Error('E47C_LARGE_SOURCE_ARCHIVE_BUDGET_LOW');
   pinnedLargeWorkerIds=await preflightLargeWorkers({
    workerA:c.workerA,workerB:c.workerB
   });
  }
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
  const ids=Array.from({length:c.count},(_,i)=>'e47c-'+runId+'-'+i);
  const stageStart=performance.now();
  // Timestamped offers are driven by a fixed monotonic schedule. ACKs may
  // overlap; exceeding maxInflight is an explicit failed campaign, not a
  // hidden queue/dropped sample or lower "successful" rate.
  const offers=await scheduleBoundedSourceOffers({
   count:c.count,rate:c.rate,maxInflight:c.maxInflight,
   maxCount:c.large?1000:250,
   send:i=>call(c.source,'/control/append',
    {eventId:ids[i],data:{slot:i,pilotRun:runId}},c.token)
  });
  offerMetrics={offeredRate:offers.offeredRate,
   acceptedCompletionRate:offers.acceptedCompletionRate,
   peakInflight:offers.peakInflight,accepted:offers.accepted,
   rejected:offers.rejected};
  raw.offer.push(...offers.rows.map(row=>({...row,eventId:ids[row.index]})));
  for(let i=0;i<c.count;i++){
   const result=offers.responses[i];
   if(result?.accepted!==true)continue;
   acknowledgements.set(ids[i],{...result.event,sourceSequence:result.sequence});
   appended++;
  }
  if(!offers.allAccepted||offers.offeredRate===null||
     offers.acceptedCompletionRate===null)
   throw Error('E47C_OPEN_LOOP_SOURCE_BACKPRESSURE_OR_ACK_FAILURE');
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
  // Force the host's scope context to initialize once on each worker
  // before opening parallel requests; this excludes cold-start context
  // races and records the worker identities used in the raw ingress audit.
  const readyA=await call(c.workerA,'/v1/recover',{scopeId:scope},c.workerToken);
  const readyB=await call(c.workerB,'/v1/recover',{scopeId:scope},c.workerToken);
  if(!readyA.workerId||!readyB.workerId||readyA.workerId===readyB.workerId)
   throw Error('E47C_WORKER_PREWARM_IDENTITY_INVALID');
  if(c.large&&(pinnedLargeWorkerIds?.[0]!==readyA.workerId||
    pinnedLargeWorkerIds?.[1]!==readyB.workerId))
   throw Error('E47C_LARGE_WORKER_IDENTITY_DRIFT');
  for(let i=0;i<c.count;i++){
   if(events.get(ids[i])?.data?.slot!==i)
    throw Error('E47C_SOURCE_SLOT_MISMATCH');
  }
  const ingested=await scheduleBoundedWorkerIngress({
   count:c.count,rate:c.rate,maxInflight:c.workerInflight,
   maxCount:c.large?1000:250,maxInflightLimit:c.large?20:8,
   workerIds:[readyA.workerId,readyB.workerId],
   deliveryMode:c.deliveryMode,
   send:i=>call(i%2?c.workerB:c.workerA,'/v1/events',{
    scopeId:scope,traceId:'trace-'+ids[i],serverId:c.sourceServerId,
    event:events.get(ids[i])
   },c.workerToken),
  });
  ingestMetrics={
   offeredRate:ingested.offeredRate,
   completedRate:ingested.acceptedCompletionRate,
   peakInflight:ingested.peakInflight,accepted:ingested.accepted,
   rejected:ingested.rejected,workerIds:[readyA.workerId,readyB.workerId]
  };
  raw.ingest.push(...ingested.rows.map(row=>({
   ...row,eventId:ids[row.index]
  })));
  for(let i=0;i<c.count;i++){
   const result=ingested.responses[i],row=ingested.rows[i];
   if(result?.accepted!==true||row.status!=='accepted')continue;
   const duration=row.completedAtMs-row.offeredAtMs;
   if(!validTiming(duration))throw Error('E47C_WORKER_DURATION_INVALID');
   raw.ei[i]={eventId:ids[i],workerId:result.workerId,
    ingestToMatchMs:result.timings.ingestToMatchMs,
    matchToWakeMs:result.persistedDeliveredWakes===1?
     result.timings.matchToWakeSamplesMs[0]:null,
    immediateDelivered:result.persistedDeliveredWakes===1,
    workerRequestCompletionMs:Math.round(duration*1000)/1000,
    ...(c.deliveryMode==='immediate'?{
     workerRequestToHostReceiptMs:Math.round(duration*1000)/1000}:{}),
   };
   elapsed.push(duration);
   observed++;
  }
  if(!ingested.allAccepted||ingested.offeredRate===null||
     ingested.acceptedCompletionRate===null)
   throw Error('E47C_WORKER_INGRESS_BACKPRESSURE_OR_ACK_FAILURE');
  const store=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
    tablePrefix:c.tablePrefix,scopeId:scope});
  await store.init();
  if(c.deliveryMode==='eventual'){
   durableDrain=await waitForDurableReceiptCount({
    expectedCount:c.count,maxExpectedCount:c.large?1000:250,
    maxWaitMs:c.drainTimeoutMs,
    readCounts:async ({remainingMs})=>{
     // Host receipt COMMIT precedes EI's own completed delivery UPDATE.
     // Read both persisted states, without inferring delivery from ACK.
     const snapshot=await pool.query({
      text:'SELECT count(*)::integer AS receipts, '+
       'count(DISTINCT wake_id)::integer AS unique_wakes, '+
       'count(DISTINCT receipt_id)::integer AS unique_receipts, '+
       '(SELECT count(*)::integer FROM '+c.tablePrefix+'_records '+
       "WHERE scope_id=$1 AND kind='wake_delivery' AND "+
       "payload->>'status'='delivered') AS delivered "+
       'FROM ei_validation_host_receipts WHERE scope_id=$1',
      values:[scope],query_timeout:remainingMs
     });
     const row=snapshot.rows[0];
     return {receipts:row.receipts,uniqueWakes:row.unique_wakes,
      uniqueReceipts:row.unique_receipts,delivered:row.delivered};
    }
   });
  }
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
   raw.source.push({eventId,sourceSequence:acknowledgements.get(eventId).sourceSequence,occurredAt:events.get(eventId).timestamp,slot:i});
   raw.host.push({eventId,wakeId,runtimeReceiptId:receipt.receipt_id,attemptCount:1});
   raw.ei[i].wakeId=wakeId;raw.ei[i].runtimeReceiptId=receipt.receipt_id;
   // Worker-request-to-host-receipt is NOT provider-to-business-effect end-to-end.
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
  for(const id of ids){
   const original=independent.events.find(e=>e.eventId===id);
   const polled=events.get(id),ack=acknowledgements.get(id);
   if(!original||!polled||!ack||original.name!==polled.name||
      original.timestamp!==polled.timestamp||
      original.name!==ack.name||original.timestamp!==ack.occurredAt||
      JSON.stringify(original.data)!==JSON.stringify(polled.data)||
      JSON.stringify(original.data)!==JSON.stringify(ack.data))
    throw Error('E47C_SOURCE_ORACLE_PAYLOAD_OR_TIME_DISAGREEMENT');
  }
  const frontierProof={schema:'ei.e47c.frontier-proof.v1',
    verifiedAt:new Date().toISOString(),sourceLog:frontier.sourceLog,
    attestation:frontier.attestation,
    expected:c.oracleExpected,signerSha256:c.signerSha};
  const proofBytes=Buffer.from(JSON.stringify(frontierProof,null,2)+'\n');
  const savedProof=await saveRaw(evidenceDir,'source-frontier-proof.json',proofBytes);
  const manifests={};
  for(const [kind,rows] of Object.entries(raw)){
   const bytes=Buffer.from(rows.map(v=>JSON.stringify(v)).join('\n')+'\n');
   manifests[kind]=await saveRaw(evidenceDir,kind+'.jsonl',bytes);
  }
  const report={schema:c.large?
   'ei.e47c.progressive-1k-durable-preflight.v3':
   c.deliveryMode==='eventual'?
   'ei.e47c.progressive-1k-durable-preflight.v2':
   'ei.e47c.progressive-1k-preflight.v1',
   sourceCommitSha:c.sourceSha,runId,scopeDigest:sha(scope),
   stage:{triggers:inserted,requestedRatePerSecond:c.rate,
    offeredEventRateMeasuredPerSecond:offerMetrics.offeredRate,
    acceptedAppendCompletionRateMeasuredPerSecond:offerMetrics.acceptedCompletionRate,
   workerIngressOfferedRateMeasuredPerSecond:ingestMetrics.offeredRate,
   workerIngressCompletionRateMeasuredPerSecond:ingestMetrics.completedRate,
   workerIngressPeakInflight:ingestMetrics.peakInflight,
    maxSourceAppendInflight:c.maxInflight,
    maxObservedSourceAppendInflight:offerMetrics.peakInflight,
    sourceAcceptedOffers:offerMetrics.accepted,
    sourceRejectedOffers:offerMetrics.rejected,
    workerIngestPacedIndependently:true,
    workerIngressMaxInflight:c.workerInflight,
    workerIngressPeakInflight:ingestMetrics.peakInflight,
    workerIngressAccepted:ingestMetrics.accepted,
    workerIngressRejected:ingestMetrics.rejected,
    workerIngressOfferedRatePerSecond:ingestMetrics.offeredRate,
    workerIngressCompletionRatePerSecond:ingestMetrics.completedRate,
    workerIngressWorkerIds:ingestMetrics.workerIds,
    durationSeconds:Math.round((performance.now()-stageStart)/10)/100,
    events:appended,observed,
    ...(c.large?{largeEventOptIn:true,requestedEventBudget:1000}:{}),
    ...(c.deliveryMode==='eventual'?{
     deliveryMode:'eventual',durableDrain,
     deferredImmediateResponses:raw.ei.filter(x=>!x.immediateDelivered).length,
     workerRequestCompletionMs:{p50:nearestRank(elapsed,.5),
      p95:nearestRank(elapsed,.95),p99:nearestRank(elapsed,.99)}
    }:{}),
    independentEIPools:2,sourceFirstPartySeparateService:true,
    hostFirstPartySeparateService:true,hostDbSharedWithEI:true,
    sourceEventLogSha256:fileArchive.sha256,sourceOracleVerified:true,
    hostWakeReceipts:receipts.rows.length,duplicateHostEffects:0,
    ...(c.deliveryMode==='immediate'?{workerRequestToHostReceiptMs:{
     p50:nearestRank(elapsed,.5),p95:nearestRank(elapsed,.95),
     p99:nearestRank(elapsed,.99)}}:{})},
   rawManifest:manifests,frontierProof:savedProof,
   acceptanceE47CVerified:false,productionSloCertified:false,
   ratePacingIsSerialAppend:false,sourceAndHostAreFirstParty:true,
   offeredPacingIndependentOfAck:true,
   workerIngressPacingIndependentOfAck:true,
   limitations:[...(c.large?[]:['stage-event-count-below-1000']),
    'one-cardinality-per-run',
    'source-append-and-worker-ingest-two-separate-phases-not-live-overlapped',
    'two-rate-completion-requires-distinct-runs','shared-host-ei-postgres',
    'no-independent-enterprise-security-or-physical-db-io-signoff']};
  const reportBytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
  const saved=await saveRaw(evidenceDir,'pilot-manifest.json',reportBytes);
  console.log(JSON.stringify({event:'ei_e47c_progressive_1k_stage',
   status:'passed',runId,stageTriggerCount:inserted,
   requestedRatePerSecond:c.rate,
   offeredRateMeasuredPerSecond:offerMetrics.offeredRate,
   acceptedAppendCompletionRateMeasuredPerSecond:offerMetrics.acceptedCompletionRate,
   maxObservedSourceAppendInflight:offerMetrics.peakInflight,
   artifactSha256:saved.sha256,
   sourceLogSha256:fileArchive.sha256,eventCount:observed,
   twoWorkers:true,hostReceipts:receipts.rows.length,
   productionSloCertified:false,acceptanceE47CVerified:false}));
 }catch(e){
  // Preserve all original observations available on partial failure.
  try{
   const partial={schema:'ei.e47c.live-pilot-partial.v1',
    sourceCommitSha:c.sourceSha,runId,scopeDigest:sha(scope),
    inserted,appended,observed,offerMetrics,ingestMetrics,
    deliveryMode:c.deliveryMode,durableDrain,
    acceptanceE47CVerified:false,productionSloCertified:false,
   ratePacingIsSerialAppend:false,sourceAndHostAreFirstParty:true,
    status:'failed',errorCode:String(e?.message??'UNKNOWN').slice(0,110)};
   for(const [kind,rows] of Object.entries(raw)){
    if(!rows.length)continue;
    const bytes=Buffer.from(rows.map(v=>JSON.stringify(v)).join('\n')+'\n');
    await saveRaw(evidenceDir,'partial-'+kind+'.jsonl',bytes);
   }
   await saveRaw(evidenceDir,'partial-manifest.json',
    Buffer.from(JSON.stringify(partial,null,2)+'\n'));
  }catch(archiveError){
   console.error(JSON.stringify({event:'e47c_partial_archive_failed',
    code:String(archiveError?.message??'UNKNOWN').slice(0,100)}));
  }
  console.error(JSON.stringify({event:'ei_e47c_progressive_1k_stage',
   status:'failed',code:String(e?.message??'unknown').slice(0,110),
   runId,inserted,appended,observed,
   acceptanceE47CVerified:false,productionSloCertified:false}));
  process.exitCode=1;
 }finally{await pool.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
