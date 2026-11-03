// E47-C progressive 1k stage: SECOND PROCESS verification of original bytes.
// This checks internal consistency and Ed25519 source-log provenance only.
// It never turns a small first-party staging pilot into production certification.
import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyStandaloneOracle} from './standalone-mcp-source-oracle.mjs';
import {rateFromTimeline} from './e47c-open-loop-pacing.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
const exactId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(value);
const hex64=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const validTiming=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const knownFile=value=>typeof value==='string'&&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.(?:json|jsonl)$/.test(value);

async function readBoundedFile(path,maxBytes){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=await file.stat();
  if(!stat.isFile()||stat.size<1||stat.size>maxBytes)fail('E47C_ARTIFACT_SIZE_OR_TYPE');
  const bytes=await file.readFile();
  if(bytes.length>maxBytes)fail('E47C_ARTIFACT_GREW');
  return bytes;
 }finally{await file.close();}
}
function decodeJson(bytes){
 try {const row=JSON.parse(bytes.toString('utf8'));
  if(!row||typeof row!=='object'||Array.isArray(row))fail('E47C_NOT_OBJECT');
  return row;
 } catch {fail('E47C_BAD_JSON');}
}
function decodeJsonl(bytes){
 const string=bytes.toString('utf8');
 if(!string.endsWith('\n')||string.includes('\r')||!string.trim())
  fail('E47C_BAD_JSONL_BOUNDARY');
 const lines=string.slice(0,-1).split('\n');
 if(lines.length>5000)fail('E47C_TOO_MANY_RAW_SAMPLES');
 return lines.map(line=>decodeJson(Buffer.from(line)));
}
async function readBoundedArtifact(dir,reference,max=32*1024*1024){
 if(!knownFile(reference?.name)||!hex64(reference?.sha256)||
    !Number.isSafeInteger(reference?.bytes)||reference.bytes<1||
    reference.bytes>max)fail('E47C_INVALID_ARTIFACT_DESCRIPTOR');
 const bytes=await readBoundedFile(join(dir,reference.name),max);
 if(bytes.length!==reference.bytes||hash(bytes)!==reference.sha256)
  fail('E47C_ARTIFACT_SHA_MISMATCH');
 return bytes;
}
const percentile=(values,p)=>{
 const a=[...values].sort((x,y)=>x-y);
 return Math.round(a[Math.ceil(a.length*p)-1]*1000)/1000;
};
function stats(rows,field){
 const series=rows.map(r=>r[field]);
 if(!series.length||series.some(x=>!validTiming(x)))
  fail('E47C_INCOMPLETE_OR_INVALID_'+field);
 return {p50:percentile(series,.5),p95:percentile(series,.95),
   p99:percentile(series,.99)};
}
function verifySourceOpenLoop({manifest,offers,sourceById,count}){
 if(manifest.ratePacingIsSerialAppend!==false||
    manifest.offeredPacingIndependentOfAck!==true||
    !Array.isArray(offers)||offers.length!==count||
    manifest.stage.sourceAcceptedOffers!==count||
    manifest.stage.sourceRejectedOffers!==0||
    !Number.isSafeInteger(manifest.stage.maxSourceAppendInflight)||
    manifest.stage.maxSourceAppendInflight<1||
    manifest.stage.maxSourceAppendInflight>8||
    !Number.isSafeInteger(manifest.stage.maxObservedSourceAppendInflight)||
    manifest.stage.maxObservedSourceAppendInflight<1||
    manifest.stage.maxObservedSourceAppendInflight>manifest.stage.maxSourceAppendInflight)
  fail('E47C_OPEN_LOOP_METADATA_OR_COUNTS');
 const ids=new Set(),timeline=[];
 for(let i=0;i<count;i++){
  const o=offers[i];
  const nominal=i*1000/manifest.stage.requestedRatePerSecond;
  if(o?.index!==i||!exactId(o?.eventId)||ids.has(o.eventId)||
     !sourceById.has(o.eventId)||o.status!=='accepted'||
     !validTiming(o.scheduledAtMs)||!validTiming(o.offeredAtMs)||
     !validTiming(o.offerLatenessMs)||!validTiming(o.completedAtMs)||
     !Number.isSafeInteger(o.offerOrder)||!Number.isSafeInteger(o.completedOrder)||
     o.offerOrder<1||o.completedOrder<=o.offerOrder||
     Math.abs(o.scheduledAtMs-nominal)>0.002||
     o.offeredAtMs<o.scheduledAtMs-0.002||
     Math.abs(Math.max(0,o.offeredAtMs-o.scheduledAtMs)-o.offerLatenessMs)>0.003||
     o.completedAtMs<o.offeredAtMs)
    fail('E47C_OPEN_LOOP_RAW_OR_SEQUENCE_INVALID');
  ids.add(o.eventId);
  timeline.push({kind:1,t:o.offeredAtMs,order:o.offerOrder},
   {kind:-1,t:o.completedAtMs,order:o.completedOrder});
 }
 // Native monotonic transition ordinals disambiguate equal rounded
 // timestamps, including zero-duration ACKs. No fabricated overlap.
 timeline.sort((a,b)=>a.order-b.order);
 let active=0,peak=0,lastTime=0;
 for(let i=0;i<timeline.length;i++){
  const mark=timeline[i];
  if(mark.order!==i+1||mark.t+0.002<lastTime)
   fail('E47C_OPEN_LOOP_TRANSITION_ORDER_INVALID');
  lastTime=Math.max(lastTime,mark.t);
  active+=mark.kind;
  if(active<0)fail('E47C_OPEN_LOOP_NEGATIVE_INFLIGHT');
  peak=Math.max(peak,active);
 }
 if(active!==0)fail('E47C_OPEN_LOOP_UNSETTLED_OFFERS');
 if(peak>manifest.stage.maxSourceAppendInflight||
    peak!==manifest.stage.maxObservedSourceAppendInflight)
  fail('E47C_OPEN_LOOP_INFLIGHT_MISMATCH');
 const offered=rateFromTimeline(offers,'offeredAtMs');
 const completed=rateFromTimeline(
  [...offers].sort((a,b)=>a.completedAtMs-b.completedAtMs),'completedAtMs');
 if(offered===null||completed===null||
    !validTiming(manifest.stage.offeredEventRateMeasuredPerSecond)||
    manifest.stage.offeredEventRateMeasuredPerSecond<=0||
    !validTiming(manifest.stage.acceptedAppendCompletionRateMeasuredPerSecond)||
    manifest.stage.acceptedAppendCompletionRateMeasuredPerSecond<=0||
    Math.abs(offered-manifest.stage.offeredEventRateMeasuredPerSecond)>0.002||
    Math.abs(completed-manifest.stage.acceptedAppendCompletionRateMeasuredPerSecond)>0.002)
  fail('E47C_OPEN_LOOP_RATE_MISMATCH');
 return {rate:offered,completionRate:completed,
  peakInflight:manifest.stage.maxObservedSourceAppendInflight};
}

function verifyWorkerIngress({manifest,ingest,ei,sourceById,count,eventual=false}){
 const stage=manifest.stage;
 if(manifest.workerIngressPacingIndependentOfAck!==true||
    stage.workerIngestPacedIndependently!==true||
    !Array.isArray(ingest)||ingest.length!==count||
    stage.workerIngressAccepted!==count||stage.workerIngressRejected!==0||
    !Number.isSafeInteger(stage.workerIngressMaxInflight)||
    stage.workerIngressMaxInflight<1||stage.workerIngressMaxInflight>8||
    !Number.isSafeInteger(stage.workerIngressPeakInflight)||
    stage.workerIngressPeakInflight<1||
    stage.workerIngressPeakInflight>stage.workerIngressMaxInflight||
    !Array.isArray(stage.workerIngressWorkerIds)||
    stage.workerIngressWorkerIds.length!==2||
    stage.workerIngressWorkerIds.some(id=>!exactId(id))||
    stage.workerIngressWorkerIds[0]===stage.workerIngressWorkerIds[1])
  fail('E47C_WORKER_INGRESS_METADATA_INVALID');
 const activeTransitions=[],seen=new Set();
 for(let i=0;i<count;i++){
  const item=ingest[i],expectedWorker=stage.workerIngressWorkerIds[i%2];
  const nominal=i*1000/stage.requestedRatePerSecond;
  if(item?.index!==i||item?.status!=='accepted'||
     !exactId(item.eventId)||!sourceById.has(item.eventId)||
     seen.has(item.eventId)||item.workerId!==expectedWorker||
     ei[i]?.eventId!==item.eventId||ei[i].workerId!==expectedWorker||
     !validTiming(item.scheduledAtMs)||!validTiming(item.offeredAtMs)||
     !validTiming(item.offerLatenessMs)||!validTiming(item.completedAtMs)||
     !Number.isSafeInteger(item.offerOrder)||
     !Number.isSafeInteger(item.completedOrder)||
     item.offerOrder<1||item.completedOrder<=item.offerOrder||
     Math.abs(item.scheduledAtMs-nominal)>0.002||
     item.offeredAtMs<item.scheduledAtMs-0.002||
     Math.abs(Math.max(0,item.offeredAtMs-item.scheduledAtMs)-
      item.offerLatenessMs)>0.003||
     item.completedAtMs<item.offeredAtMs||
     Math.abs((item.completedAtMs-item.offeredAtMs)-
      ei[i][eventual?'workerRequestCompletionMs':
       'workerRequestToHostReceiptMs'])>0.003)
   fail('E47C_WORKER_INGRESS_LINEAGE_OR_TIME_INVALID');
  seen.add(item.eventId);
  activeTransitions.push({order:item.offerOrder,time:item.offeredAtMs,delta:1},
   {order:item.completedOrder,time:item.completedAtMs,delta:-1});
 }
 activeTransitions.sort((a,b)=>a.order-b.order);
 let active=0,peak=0,lastTime=0;
 for(let i=0;i<activeTransitions.length;i++){
  const t=activeTransitions[i];
  if(t.order!==i+1||t.time+0.002<lastTime)
   fail('E47C_WORKER_INGRESS_ORDER_INVALID');
  lastTime=Math.max(lastTime,t.time);
  active+=t.delta;
  if(active<0)fail('E47C_WORKER_INGRESS_NEGATIVE_INFLIGHT');
  peak=Math.max(peak,active);
 }
 if(active!==0||peak!==stage.workerIngressPeakInflight)
  fail('E47C_WORKER_INGRESS_PEAK_MISMATCH');
 const offered=rateFromTimeline(ingest,'offeredAtMs');
 const completed=rateFromTimeline(
  [...ingest].sort((a,b)=>a.completedAtMs-b.completedAtMs),
  'completedAtMs');
 if(offered===null||completed===null||
    !validTiming(stage.workerIngressOfferedRatePerSecond)||
    stage.workerIngressOfferedRatePerSecond<=0||
    !validTiming(stage.workerIngressCompletionRatePerSecond)||
    stage.workerIngressCompletionRatePerSecond<=0||
    Math.abs(offered-stage.workerIngressOfferedRatePerSecond)>0.002||
    Math.abs(completed-stage.workerIngressCompletionRatePerSecond)>0.002)
  fail('E47C_WORKER_INGRESS_RATE_MISMATCH');
 return {offeredRate:offered,completionRate:completed,peakInflight:peak,
  distinctWorkers:2};
}

export function assessProgressiveE47CStage({manifest,source,host,ei,offers,ingest,originalEvents,originalSequenceById}={}){
 const eventual=manifest?.schema==='ei.e47c.progressive-1k-durable-preflight.v2';
 if(!eventual&&manifest?.schema!=='ei.e47c.progressive-1k-preflight.v1'||
    manifest?.acceptanceE47CVerified!==false||
    manifest?.productionSloCertified!==false||
    manifest?.stage?.sourceOracleVerified!==true||
    manifest?.stage?.hostDbSharedWithEI!==true)
  fail('E47C_NOT_BOUNDED_PILOT');
 const count=manifest.stage.events;
 if(!Number.isSafeInteger(count)||count<10||count>250||
    manifest.stage.triggers!==1000||
    ![1,5].includes(manifest.stage.requestedRatePerSecond)||
    !validTiming(manifest.stage.offeredEventRateMeasuredPerSecond)||
    manifest.stage.offeredEventRateMeasuredPerSecond<=0||
    !validTiming(manifest.stage.durationSeconds)||manifest.stage.durationSeconds<=0||
    manifest.stage.observed!==count||manifest.stage.hostWakeReceipts!==count||
    manifest.stage.duplicateHostEffects!==0||
    source?.length!==count||host?.length!==count||ei?.length!==count)
  fail('E47C_RAW_COUNTS_OR_BOUNDS');
 const originalMap=new Map(originalEvents?.map(x=>[x.eventId,x]));
 if(originalMap.size!==(originalEvents?.length??-1))
  fail('E47C_DUPLICATE_ORIGINAL_SOURCE_EVENT');
 const ids=new Set(),wakeIds=new Set(),receipts=new Set(),workers=new Set();
 const sourceSequences=new Set();
 const sourceById=new Map(source.map(s=>[s.eventId,s]));
 const hostById=new Map(host.map(h=>[h.eventId,h]));
 if(sourceById.size!==count||hostById.size!==count)
  fail('E47C_DUPLICATE_SOURCE_OR_HOST_ROW');
 for(const row of ei){
  if(!exactId(row.eventId)||ids.has(row.eventId)||
     !exactId(row.wakeId)||wakeIds.has(row.wakeId)||
     !exactId(row.runtimeReceiptId)||receipts.has(row.runtimeReceiptId)||
     !exactId(row.workerId)||
     !validTiming(row.ingestToMatchMs)||
     (eventual?(typeof row.immediateDelivered!=='boolean'||
      !validTiming(row.workerRequestCompletionMs)||
      (row.immediateDelivered?!validTiming(row.matchToWakeMs):
       row.matchToWakeMs!==null)):
      (!validTiming(row.matchToWakeMs)||
       !validTiming(row.workerRequestToHostReceiptMs))))
   fail('E47C_INVALID_OR_DUPLICATE_EI_ROW');
  const s=sourceById.get(row.eventId),h=hostById.get(row.eventId);
  const original=originalMap.get(row.eventId);
  if(!s||!h||!original||s.occurredAt!==original.timestamp||
     !Number.isSafeInteger(s.sourceSequence)||s.sourceSequence<=0||
     sourceSequences.has(s.sourceSequence)||
     !(originalSequenceById instanceof Map)||
     originalSequenceById.get(row.eventId)!==s.sourceSequence||
     !Number.isSafeInteger(s.slot)||original.data?.slot!==s.slot||
     h.wakeId!==row.wakeId||h.runtimeReceiptId!==row.runtimeReceiptId||
     h.attemptCount!==1)
   fail('E47C_SOURCE_EI_HOST_LINEAGE_MISMATCH');
  ids.add(row.eventId);sourceSequences.add(s.sourceSequence);wakeIds.add(row.wakeId);
  receipts.add(row.runtimeReceiptId);workers.add(row.workerId);
 }
 if(workers.size!==2)fail('E47C_NOT_TWO_DISTINCT_WORKERS');
 const openLoop=manifest.ratePacingIsSerialAppend===false?
  verifySourceOpenLoop({manifest,offers,sourceById,count}):null;
 const workerIngress=manifest.workerIngressPacingIndependentOfAck===true?
  verifyWorkerIngress({manifest,ingest,ei,sourceById,count,eventual}):null;
 const immediateRows=eventual?ei.filter(r=>r.immediateDelivered):ei;
 if(eventual){
  const drain=manifest.stage.durableDrain;
  if(manifest.stage.deliveryMode!=='eventual'||
     manifest.stage.deferredImmediateResponses!==count-immediateRows.length||
     drain?.settledCount!==count||drain?.requirePerEventLineage!==true||
     drain?.productionSloCertified!==false||
     !Number.isSafeInteger(drain.polls)||drain.polls<1||
     !validTiming(drain.drainElapsedMs))
   fail('E47C_DURABLE_SETTLEMENT_EVIDENCE_INVALID');
 }
 const workerDurationKey=eventual?'workerRequestCompletionMs':
  'workerRequestToHostReceiptMs';
 const observedLatency=stats(ei,workerDurationKey);
 const manifestLatency=manifest.stage[workerDurationKey];
 for(const k of ['p50','p95','p99']){
  if(!validTiming(manifestLatency?.[k])||
    Math.abs(observedLatency[k]-manifestLatency[k])>0.001)
   fail('E47C_PILOT_QUANTILE_MISMATCH_'+k);
 }
 if(!hex64(manifest.stage.sourceEventLogSha256))
  fail('E47C_MISSING_ORIGINAL_SOURCE_SHA');
 return Object.freeze({
  schema:'ei.e47c.offline-progressive-1k-reaudit.v1',
  status:'raw-consistent-first-party-staging-only',
  triggerCount:1000,
  requestedRatePerSecond:manifest.stage.requestedRatePerSecond,
  observedAppendCompletionRatePerSecond:openLoop?.completionRate??manifest.stage.offeredEventRateMeasuredPerSecond,
  sourcePacingIsSerial:openLoop===null,
  sourceOpenLoop:openLoop,
  workerIngress,
  acceptanceE47CVerified:false,productionSloCertified:false,
  independentlyOperatedBusinessProviderProven:false,
  independentHostReceiptStorageProven:false,
  eventCount:count,hostReceipts:receipts.size,
  distinctEIWorkers:workers.size,
  latency:{
   ingestToMatch:stats(ei,'ingestToMatchMs'),
   matchToWake:immediateRows.length>0?stats(immediateRows,'matchToWakeMs'):null,
   matchToWakeObservedSamples:immediateRows.length,
   matchToWakeCensoredSamples:count-immediateRows.length,
   workerRequestToHostReceipt:eventual?null:observedLatency,
   workerRequestCompletion:eventual?observedLatency:null,
  },
 });
}
export async function verifyPersistedProgressiveE47CStage({
 dir,runId,rate,publicKeyPem,signerSha256,
 expectedManifestSha256,expectedSourceLogSha256,
}={}){
 if(![1,5].includes(rate)||!isAbsolute(dir)||dir==='/'||dir.startsWith('/tmp')||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId??'')||
    !publicKeyPem||!hex64(signerSha256)||
    !hex64(expectedManifestSha256)||!hex64(expectedSourceLogSha256)||
    hash(publicKeyPem)!==signerSha256)
  fail('E47C_REAUDIT_CONFIG_INVALID');
 const folder=join(dir,'ei-e47c-progressive-1k-r'+rate+'-'+runId);
 const manifestBytes=await readBoundedFile(join(folder,'pilot-manifest.json'),1024*1024);
 // Independently pinned from the original Railway deployment's structured
 // append-only runtime log, not from writable files on this volume.
 if(hash(manifestBytes)!==expectedManifestSha256)
  fail('E47C_OUT_OF_BAND_MANIFEST_SHA_MISMATCH');
 const manifest=decodeJson(manifestBytes);
 if(manifest.runId!==runId||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommitSha??''))
  fail('E47C_RUN_ID_OR_COMMIT_MISMATCH');
 if(manifest.stage?.requestedRatePerSecond!==rate)fail('E47C_RATE_MISMATCH');
 const source=decodeJsonl(await readBoundedArtifact(folder,manifest.rawManifest?.source));
 const host=decodeJsonl(await readBoundedArtifact(folder,manifest.rawManifest?.host));
 const ei=decodeJsonl(await readBoundedArtifact(folder,manifest.rawManifest?.ei));
 const offers=manifest.ratePacingIsSerialAppend===false?
  decodeJsonl(await readBoundedArtifact(folder,manifest.rawManifest?.offer)):undefined;
 const ingest=manifest.workerIngressPacingIndependentOfAck===true?
  decodeJsonl(await readBoundedArtifact(folder,manifest.rawManifest?.ingest)):undefined;
 const proof=decodeJson(await readBoundedArtifact(folder,manifest.frontierProof,1024*1024));
 if(proof.schema!=='ei.e47c.frontier-proof.v1'||proof.signerSha256!==signerSha256)
  fail('E47C_FRONTIER_PROOF_MISMATCH');
 const originalPath=join(folder,'original-source.jsonl');
 const originalBytes=await readBoundedFile(originalPath,32*1024*1024);
 if(hash(originalBytes)!==manifest.stage?.sourceEventLogSha256||
    hash(originalBytes)!==expectedSourceLogSha256)
  fail('E47C_OUT_OF_BAND_SOURCE_LOG_SHA_MISMATCH');
 // This is a *historical* signed frontier, not a currently valid completeness
 // guarantee. Offline review uses saved observation-time claim and must not
 // imply it was freshly received from a third-party provider.
 const verifiedAtMs=Date.parse(proof.verifiedAt);
 if(!Number.isFinite(verifiedAtMs)||verifiedAtMs>Date.now()+300000)
  fail('E47C_FRONTIER_TIME_INVALID');
 const oracle=await verifyStandaloneOracle({
  logBytes:originalBytes,sourceLog:proof.sourceLog,
  attestation:proof.attestation,publicKeyPem,
  expected:proof.expected,now:verifiedAtMs
 });
 if(oracle?.valid!==true)fail('E47C_SIGNED_SOURCE_ORACLE_INVALID');
 const originalSequenceById=new Map();
 // The oracle validated the complete source hash-chain over these same
 // bounded bytes, so the sequence is anchored to the original snapshot.
 for(const line of originalBytes.toString('utf8').trimEnd().split('\n')){
  const row=JSON.parse(line);
  if(row.payload?.kind==='event'){
   if(originalSequenceById.has(row.payload.eventId))
    fail('E47C_DUPLICATE_ORIGINAL_SOURCE_SEQUENCE');
   originalSequenceById.set(row.payload.eventId,row.seq);
  }
 }
 const audit=assessProgressiveE47CStage({manifest,source,host,ei,offers,ingest,
  originalEvents:oracle.events,originalSequenceById});
 return Object.freeze({...audit,sourceCommitSha:manifest.sourceCommitSha,
  runId,rawManifestSha256:hash(manifestBytes),
  sourceLogSha256:hash(originalBytes),
  outOfBandManifestHashVerified:true,
  outOfBandSourceLogHashVerified:true,
  // Ed25519 covers the historical frontier claim, not the source-log hash
  // chain bytes. Raw log anchoring is from separately observed deployment
  // hashes, not a signature over each event.
  sourceLogSignatureReverified:false,
  signedFrontierClaimSignatureReverified:true,
  signedClaimReplayedAtStoredObservationTime:true,
  signedClaimCurrentlyFresh:false});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const result=await verifyPersistedProgressiveE47CStage({
   dir:process.env.EI_E47C_ARTIFACT_DIR,
   runId:process.env.EI_E47C_PILOT_RUN_ID,
   rate:Number(process.env.EI_E47C_STAGE_RATE),
   publicKeyPem:process.env.EI_SOURCE_TRUSTED_PUBLIC_KEY_PEM?.replace(/\\n/g,'\n'),
   signerSha256:process.env.EI_SOURCE_TRUSTED_PUBLIC_KEY_SHA256,
   expectedManifestSha256:process.env.EI_E47C_EXPECTED_MANIFEST_SHA256,
   expectedSourceLogSha256:process.env.EI_E47C_EXPECTED_SOURCE_LOG_SHA256,
  });
  console.log(JSON.stringify({event:'e47c_independent_progressive_1k_raw_reaudit',...result}));
 }catch(e){
  console.error(JSON.stringify({event:'e47c_independent_progressive_1k_raw_reaudit',
   status:'blocked',reason:String(e?.code??'E47C_RAW_REAUDIT_FAILED').slice(0,110),
   acceptanceE47CVerified:false,productionSloCertified:false}));
  process.exitCode=1;
 }
}
