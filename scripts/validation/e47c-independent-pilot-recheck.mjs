// E47-C pilot: a SECOND OS process verifies persisted private artifacts.
// This checks internal consistency and Ed25519 source-log provenance only.
// It never turns a small first-party staging pilot into production certification.
import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyStandaloneOracle} from './standalone-mcp-source-oracle.mjs';

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
export function assessLiveE47CPilot({manifest,source,host,ei,originalEvents}={}){
 if(manifest?.schema!=='ei.e47c.live-pilot.v1'||
    manifest?.acceptanceE47CVerified!==false||
    manifest?.productionSloCertified!==false||
    manifest?.stage?.sourceOracleVerified!==true||
    manifest?.stage?.hostDbSharedWithEI!==true)
  fail('E47C_NOT_BOUNDED_PILOT');
 const count=manifest.stage.events;
 if(!Number.isSafeInteger(count)||count<2||count>25||
    manifest.stage.triggers<count||manifest.stage.triggers>1000||
    manifest.stage.observed!==count||manifest.stage.hostWakeReceipts!==count||
    manifest.stage.duplicateHostEffects!==0||
    source?.length!==count||host?.length!==count||ei?.length!==count)
  fail('E47C_RAW_COUNTS_OR_BOUNDS');
 const originalMap=new Map(originalEvents?.map(x=>[x.eventId,x]));
 if(originalMap.size!==(originalEvents?.length??-1))
  fail('E47C_DUPLICATE_ORIGINAL_SOURCE_EVENT');
 const ids=new Set(),wakeIds=new Set(),receipts=new Set(),workers=new Set();
 const sourceById=new Map(source.map(s=>[s.eventId,s]));
 const hostById=new Map(host.map(h=>[h.eventId,h]));
 if(sourceById.size!==count||hostById.size!==count)
  fail('E47C_DUPLICATE_SOURCE_OR_HOST_ROW');
 for(const row of ei){
  if(!exactId(row.eventId)||ids.has(row.eventId)||
     !exactId(row.wakeId)||wakeIds.has(row.wakeId)||
     !exactId(row.runtimeReceiptId)||receipts.has(row.runtimeReceiptId)||
     !exactId(row.workerId)||
     !validTiming(row.ingestToMatchMs)||!validTiming(row.matchToWakeMs)||
     !validTiming(row.workerRequestToHostReceiptMs))
   fail('E47C_INVALID_OR_DUPLICATE_EI_ROW');
  const s=sourceById.get(row.eventId),h=hostById.get(row.eventId);
  const original=originalMap.get(row.eventId);
  if(!s||!h||!original||s.occurredAt!==original.timestamp||
     !Number.isSafeInteger(s.slot)||original.data?.slot!==s.slot||
     h.wakeId!==row.wakeId||h.runtimeReceiptId!==row.runtimeReceiptId||
     h.attemptCount!==1)
   fail('E47C_SOURCE_EI_HOST_LINEAGE_MISMATCH');
  ids.add(row.eventId);wakeIds.add(row.wakeId);
  receipts.add(row.runtimeReceiptId);workers.add(row.workerId);
 }
 if(workers.size!==2)fail('E47C_NOT_TWO_DISTINCT_WORKERS');
 const observedLatency=stats(ei,'workerRequestToHostReceiptMs');
 for(const k of ['p50','p95','p99']){
  if(!validTiming(manifest.stage.workerRequestToHostReceiptMs?.[k])||
    Math.abs(observedLatency[k]-manifest.stage.workerRequestToHostReceiptMs[k])>0.001)
   fail('E47C_PILOT_QUANTILE_MISMATCH_'+k);
 }
 if(!hex64(manifest.stage.sourceEventLogSha256))
  fail('E47C_MISSING_ORIGINAL_SOURCE_SHA');
 return Object.freeze({
  schema:'ei.e47c.offline-pilot-reaudit.v1',
  status:'raw-consistent-first-party-staging-only',
  acceptanceE47CVerified:false,productionSloCertified:false,
  independentlyOperatedBusinessProviderProven:false,
  independentHostReceiptStorageProven:false,
  eventCount:count,hostReceipts:receipts.size,
  distinctEIWorkers:workers.size,
  latency:{
   ingestToMatch:stats(ei,'ingestToMatchMs'),
   matchToWake:stats(ei,'matchToWakeMs'),
   workerRequestToHostReceipt:observedLatency,
  },
 });
}
export async function verifyPersistedLiveE47CPilot({
 dir,runId,publicKeyPem,signerSha256,
 expectedManifestSha256,expectedSourceLogSha256,
}={}){
 if(!isAbsolute(dir)||dir==='/'||dir.startsWith('/tmp')||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId??'')||
    !publicKeyPem||!hex64(signerSha256)||
    !hex64(expectedManifestSha256)||!hex64(expectedSourceLogSha256)||
    hash(publicKeyPem)!==signerSha256)
  fail('E47C_REAUDIT_CONFIG_INVALID');
 const folder=join(dir,'ei-e47c-pilot-'+runId);
 const manifestBytes=await readBoundedFile(join(folder,'pilot-manifest.json'),1024*1024);
 // Independently pinned from the original Railway deployment's structured
 // append-only runtime log, not from writable files on this volume.
 if(hash(manifestBytes)!==expectedManifestSha256)
  fail('E47C_OUT_OF_BAND_MANIFEST_SHA_MISMATCH');
 const manifest=decodeJson(manifestBytes);
 if(manifest.runId!==runId||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommitSha??''))
  fail('E47C_RUN_ID_OR_COMMIT_MISMATCH');
 const source=decodeJsonl(await readBoundedArtifact(folder,manifest.rawManifest?.source));
 const host=decodeJsonl(await readBoundedArtifact(folder,manifest.rawManifest?.host));
 const ei=decodeJsonl(await readBoundedArtifact(folder,manifest.rawManifest?.ei));
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
 const audit=assessLiveE47CPilot({manifest,source,host,ei,
  originalEvents:oracle.events});
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
  const result=await verifyPersistedLiveE47CPilot({
   dir:process.env.EI_E47C_ARTIFACT_DIR,
   runId:process.env.EI_E47C_PILOT_RUN_ID,
   publicKeyPem:process.env.EI_SOURCE_TRUSTED_PUBLIC_KEY_PEM?.replace(/\\n/g,'\n'),
   signerSha256:process.env.EI_SOURCE_TRUSTED_PUBLIC_KEY_SHA256,
   expectedManifestSha256:process.env.EI_E47C_EXPECTED_MANIFEST_SHA256,
   expectedSourceLogSha256:process.env.EI_E47C_EXPECTED_SOURCE_LOG_SHA256,
  });
  console.log(JSON.stringify({event:'e47c_independent_pilot_raw_reaudit',...result}));
 }catch(e){
  console.error(JSON.stringify({event:'e47c_independent_pilot_raw_reaudit',
   status:'blocked',reason:String(e?.code??'E47C_RAW_REAUDIT_FAILED').slice(0,110),
   acceptanceE47CVerified:false,productionSloCertified:false}));
  process.exitCode=1;
 }
}
