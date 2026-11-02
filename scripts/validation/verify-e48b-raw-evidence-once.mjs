#!/usr/bin/env node
// Independent *second-process* operator audit of an already completed
// E48-B Railway campaign. READ ONLY; never runs tests a second time.
import {createHash} from 'node:crypto';
import {readFile,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';

const hash=x=>createHash('sha256').update(x).digest('hex');
const required=k=>{const v=process.env[k];if(!v)throw Error('MISSING_'+k);return v;};
const dir=required('EI_E48B_ARTIFACT_DIR');
const expected=required('EI_E48B_EXPECTED_MANIFEST_SHA256');
const sourceSHA=required('EI_E48B_MEASURED_SOURCE_SHA');
const finite=x=>typeof x==='number'&&Number.isFinite(x);
function assert(x,code){if(!x)throw Error('E48B_RAW_'+code);}
function stats(records,{minimum=100}={}){
 const all=records.map(x=>x.elapsedMs).sort((a,b)=>a-b);
 assert(all.length>=minimum&&all.every(v=>finite(v)&&v>=0),'LATENCY_INVALID');
 const p=percent=>all[Math.max(0,Math.min(all.length-1,Math.ceil(percent*all.length)-1))];
 const round=x=>Math.round(x*1000)/1000;
 return {n:all.length,p50:round(p(.5)),p95:round(p(.95)),p99:round(p(.99)),
  min:round(all[0]),max:round(all.at(-1)),
  mean:round(all.reduce((a,b)=>a+b,0)/all.length)};
}
function verifyProfile(profile,count,samples){
 assert(profile?.fullInspectorCalls===samples,'FULL_INSPECTOR_NOT_MEASURED');
 assert(profile.successes===samples&&profile.refusals===0,
  'UNEXPECTED_INSPECTION_FAILURES');
 assert(Array.isArray(profile.samples)&&profile.samples.length===samples,
  'MISSING_RAW_LATENCIES');
 assert(profile.samples.every((r,i)=>r.index===i&&r.outcome==='passed'),
  'OMITTED_OR_SAMPLED_REFUSALS');
 assert(JSON.stringify(stats(profile.samples))===
  JSON.stringify(profile.percentileLatencyMs),'PERCENTILES_NOT_REPRODUCIBLE');
 assert(finite(profile.processCpuMicros?.user)&&
  finite(profile.processCpuMicros?.system),'MISSING_MEASURED_CPU');
 assert(finite(profile.processRssBytes?.peak)&&
  profile.processRssBytes.peak>=profile.processRssBytes.baseline,
  'MISSING_PEAK_RSS');
 assert(profile.measurementIncludesFullInspector===true,
  'NOT_FULL_INSPECT_METHOD');
 return profile.percentileLatencyMs.p99;
}
function validateTableIO(report,count){
 const io=report?.pgReadIO;
 assert(io?.baselineDelta&&io?.hostLoadDelta,
  'PER_TEST_TABLE_IO_MISSING');
 for(const phase of [io.baselineDelta,io.hostLoadDelta]){
  for(const key of ['heapDiskReadBlocks','heapCacheHitBlocks',
    'indexDiskReadBlocks','indexCacheHitBlocks'])
   assert(finite(phase[key])&&phase[key]>=0,'INVALID_TABLE_BUFFER_DELTA');
 }
 assert(io.explainAnalyzeBuffers?.physicallyExecutedPostgresQuery===true,
  'PG_EXPLAIN_NOT_EXECUTED');
 const plan=io.explainAnalyzeBuffers.plan;
 assert(plan&&typeof plan.nodeType==='string'&&
  finite(io.explainAnalyzeBuffers.executionMs),
  'MISSING_ACTUAL_SQL_EXPLAIN');
 return {
  population:count,
  heapReads:io.hostLoadDelta.heapDiskReadBlocks,
  heapHits:io.hostLoadDelta.heapCacheHitBlocks,
  indexReads:io.hostLoadDelta.indexDiskReadBlocks,
  indexHits:io.hostLoadDelta.indexCacheHitBlocks,
  exactKeyedPgExplainMs:io.explainAnalyzeBuffers.executionMs,
 };
}
try{
 const mount=await stat(dir);
 assert(mount.isDirectory(),'EVIDENCE_VOLUME_NOT_MOUNTED');
 assert(/^[0-9a-f]{64}$/.test(expected),'MANIFEST_PIN_BAD');
 assert(/^[0-9a-f]{40}$/.test(sourceSHA),'SOURCE_SHA_INVALID');
 const names=(await readdir(dir)).filter(x=>x.startsWith('e48b-')&&
  x.endsWith('-manifest.json'));
 let name=null,manifest=null,bytes=null;
 for(const candidate of names){
  const file=await readFile(join(dir,candidate));
  if(hash(file)===expected){
   assert(name===null,'MORE_THAN_ONE_MANIFEST_MATCH');
   name=candidate;bytes=file;manifest=JSON.parse(file.toString('utf8'));
  }
 }
 assert(name!==null,'PINNED_MANIFEST_NOT_PRESENT');
 assert(manifest.schema==='ei.e48b.independent-full-inspector-railway.v1'&&
  manifest.source?.sourceSha===sourceSHA,
  'MANIFEST_SOURCE_IDENTITY_MISMATCH');
 const run=manifest.runId;
 assert(typeof run==='string'&&/^[0-9a-f-]{36}$/.test(run),
  'MANIFEST_RUN_ID_INVALID');
 assert(name==='e48b-'+run+'-manifest.json','MANIFEST_FILENAME_MISMATCH');
 const counts=[1000,10000,100000],samples=manifest.config?.samplesPerPhase;
 assert(Array.isArray(manifest.config?.counts)&&
  manifest.config.counts.join(',')===counts.join(',')&&
  Number.isSafeInteger(samples)&&samples>=100,
  'POPULATION_CONFIG_INVALID');
 assert(manifest.completedStages===3&&manifest.candidateCases?.length===3,
  'INCOMPLETE_POPULATION_SET');
 const verified=[],files=[],summary=[];
 for(const count of counts){
  const filename='e48b-'+run+'-'+count+'.json';
  const raw=await readFile(join(dir,filename));
  const item=JSON.parse(raw.toString('utf8'));
  assert(item.source?.sourceSha===sourceSHA&&
   item.caseReport?.candidatePopulation===count&&
   item.caseReport?.persistedCandidatesVerified===true&&
   item.caseReport?.exactKeyedStrictInspection===true,
   'POPULATION_NOT_GENUINELY_PERSISTED');
  const r=item.caseReport;
  assert(r.allCandidateLatestMatchRefusesSafely===true&&
   r.globalLatestRefusalCode==='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED',
   'UNBOUNDED_CANDIDATE_REFUSAL_NOT_VERIFIED');
  const p99Baseline=verifyProfile(r.baseline,count,samples);
  const p99Loaded=verifyProfile(r.loaded,count,samples);
  const host=r.hostConcurrency;
  assert(host.hostIsSeparatelyDeployed===true&&
   host.actualHostEffectReceiptsVerified===true&&
   host.hostReceiptCount>=10&&host.refused===0&&
   host.hostReceiptCount===host.delivered&&
   host.accepted===host.delivered&&
   host.accepted+host.refused===host.attempted&&
   host.uniqueHostWakes===host.hostReceiptCount&&
   host.uniqueHostReceipts===host.hostReceiptCount&&
   host.distinctWorkerCount===2&&
   host.overlappingDeliveredHostEffectCount>=5,
   'HOST_LOAD_OR_RECEIPTS_NOT_VERIFIED');
  const brief=manifest.candidateCases.find(x=>x.population===count);
  assert(brief?.stageArtifactSha256===hash(raw),
   'RAW_STAGE_DIGEST_DIFFERS_FROM_MANIFEST');
  assert(JSON.stringify(brief.baseline)===
     JSON.stringify(r.baseline.percentileLatencyMs)&&
   JSON.stringify(brief.loaded)===
     JSON.stringify(r.loaded.percentileLatencyMs)&&
   brief.hostReceipts===host.hostReceiptCount&&
   brief.baselineRefusals===r.baseline.refusals&&
   brief.loadedRefusals===r.loaded.refusals&&
   JSON.stringify(brief.tableIO)===JSON.stringify(r.pgReadIO),
   'MANIFEST_FULL_SUMMARY_OR_IO_DIFFERS_FROM_RAW');
  // Independently recompute host effect counts/worker diversity and
  // real on-wire overlap from raw per-request intervals and pinned
  // (non-secret) SHA-256 digests of persisted receipt-row IDs.
  assert(Array.isArray(host.receiptRows)&&
   host.receiptRows.length===host.hostReceiptCount&&
   host.receiptRows.every(x=>/^[a-f0-9]{64}$/.test(x.wakeDigest)&&
    /^[a-f0-9]{64}$/.test(x.receiptDigest)&&x.attemptCount===1)&&
   new Set(host.receiptRows.map(x=>x.wakeDigest)).size===host.hostReceiptCount&&
   new Set(host.receiptRows.map(x=>x.receiptDigest)).size===host.hostReceiptCount,
   'RAW_HOST_RECEIPT_IDENTITY_NOT_DISTINCT');
  assert(Array.isArray(host.intervals)&&
   host.intervals.length===host.attempted&&
   Array.isArray(host.workerIds)&&host.workerIds.length===host.accepted&&
   new Set(host.workerIds).size===2,
   'RAW_REMOTE_WORKER_IDENTITIES_MISSING');
  const window=host.inspectionWindow;
  assert(finite(window?.start)&&finite(window?.end)&&
    window.end>window.start,'INVALID_INSPECTION_WINDOW');
  assert(host.intervals.every((x,i)=>x.index===i&&
   finite(x.begin)&&finite(x.end)&&x.end>=x.begin&&
   typeof x.delivered==='boolean'&&
   (x.delivered===false||typeof x.workerId==='string')),
   'INVALID_RAW_HOST_REQUEST_INTERVALS');
  const delivered=host.intervals.filter(x=>x.delivered===true);
  const workerSequence=delivered.map(x=>x.workerId);
  assert(workerSequence.length===host.accepted&&
   JSON.stringify(workerSequence)===JSON.stringify(host.workerIds)&&
   new Set(workerSequence).size===2&&
   host.intervals.every(x=>x.delivered||x.workerId===null),
   'HOST_WORKER_IDS_NOT_REPRODUCIBLE');
  assert(Array.isArray(host.latencyMs)&&
   host.latencyMs.length===host.attempted&&
   host.latencyMs.every((v,i)=>finite(v)&&v>=0&&
    Math.abs(v-Math.round(
     (host.intervals[i].end-host.intervals[i].begin)*1000)/1000)<0.002)&&
   JSON.stringify(stats(host.latencyMs.map(elapsedMs=>({elapsedMs})),{minimum:10}))===
    JSON.stringify(host.latencySummaryMs),
   'HOST_REQUEST_LATENCIES_NOT_REPRODUCIBLE');
  const overlapping=delivered.filter(x=>
   x.begin<=window.end&&x.end>=window.start);
  assert(delivered.length===host.delivered&&
   delivered.length===host.hostReceiptCount&&
   overlapping.length===host.overlappingDeliveredHostEffectCount&&
   overlapping.length>=5,
   'ACTUAL_HOST_EFFECT_OVERLAP_NOT_REPRODUCIBLE');
  const late=Math.round((window.end-
    Math.max(...overlapping.map(x=>x.end)))*1000)/1000;
  assert(Math.abs(late-host.lastOverlappingRequestAgeMs)<0.003&&
   late<=Math.max(1500,(window.end-window.start)*.5),
   'OVERLAP_TIMING_OR_HOST_LOAD_FRESHNESS_INVALID');
  verified.push({count,p99BaselineMs:p99Baseline,p99HostLoadedMs:p99Loaded,
   hostReceipts:host.hostReceiptCount,
   actualDeliveredOverlap:host.overlappingDeliveredHostEffectCount});
  files.push({population:count,sha256:hash(raw),bytes:raw.length});
  summary.push(validateTableIO(r,count));
 }
 const faultName='e48b-'+run+'-fault.json';
 const faultRaw=await readFile(join(dir,faultName));
 assert(hash(faultRaw)===manifest.fault?.rawArtifactSha256&&
   manifest.fault.rawArtifactName===faultName,
   'UNPINNED_FAULT_SAMPLES');
 const rawFault=JSON.parse(faultRaw.toString('utf8'));
 assert(rawFault.schema==='ei.e48b.fault.raw.v1'&&
  rawFault.runId===run&&rawFault.sourceSha===sourceSHA,
  'FAULT_SOURCE_OR_RUN_MISMATCH');
 const fault=rawFault.fault;
 assert(manifest.fault.serverSidePgSleepMs===fault.serverSidePgSleepMs&&
  manifest.fault.contendedInspectorRefusals===fault.queuedFullInspect?.refusals&&
  manifest.fault.afterSleepRecoveryRefusals===fault.recoveredFullInspect?.refusals&&
  manifest.fault.postTerminationRecoveryRefusals===
   fault.afterBackendRestartFullInspect?.refusals&&
  fault.PGPrimaryWasNOTRestarted===true&&
  manifest.fault.postgresPrimaryNeverRestarted===true,
  'FAULT_MANIFEST_MISMATCH');
 function verifyFaultProfile(profile){
  assert(profile?.fullInspectorCalls===3&&
   Number.isSafeInteger(profile.successes)&&
   Number.isSafeInteger(profile.refusals)&&
   profile.successes+profile.refusals===3&&
   Array.isArray(profile.samples)&&profile.samples.length===3,
   'MISSING_RAW_PG_FAULT_SAMPLES');
  const successes=profile.samples.filter((x,i)=>x.index===i&&
   x.outcome==='passed'&&finite(x.elapsedMs)&&x.elapsedMs>=0).length;
  const refusals=profile.samples.filter((x,i)=>x.index===i&&
   x.outcome==='refused'&&finite(x.elapsedMs)&&x.elapsedMs>=0&&
   typeof x.code==='string'&&x.code.length>0).length;
  assert(successes===profile.successes&&refusals===profile.refusals,
   'RAW_PG_FAULT_SAMPLE_COUNT_MISMATCH');
  assert(JSON.stringify(stats(profile.samples,{minimum:3}))===
   JSON.stringify(profile.percentileLatencyMs),
   'RAW_PG_FAULT_PERCENTILES_MISMATCH');
  assert(finite(profile.processCpuMicros?.user)&&
   finite(profile.processRssBytes?.peak),'RAW_PG_FAULT_CPU_RSS_MISSING');
 }
 for(const p of [fault.queuedFullInspect,
  fault.recoveredFullInspect,fault.afterBackendRestartFullInspect])
  verifyFaultProfile(p);
 assert(fault.queuedFullInspect.refusals>=1&&
   fault.recoveredFullInspect.successes===3&&
   fault.recoveredFullInspect.refusals===0&&
   fault.afterBackendRestartFullInspect.successes===3&&
   fault.afterBackendRestartFullInspect.refusals===0,
   'REAL_PG_SLOW_OR_RECOVERY_FAULT_SAMPLES_MISSING');
 assert(fault.testOnlyBackendTerminationSucceeded===true&&
   manifest.fault.backendTerminationSucceeded===true,
   'ACTUAL_PG_BACKEND_TERMINATION_NOT_VERIFIED');
 console.log(JSON.stringify({event:'ei_e48b_raw_evidence_independent_recheck',
  status:'passed',
  manifestSha256:expected,sourceSHA,
  validatedPopulations:counts,
  validatedInspectorSamples:counts.length*samples*2,
  validatedHostReceipts:verified.reduce((n,x)=>n+x.hostReceipts,0),
  p99Recomputed:verified,
  tableIOVerified:summary,
  faultSampleCount:fault.queuedFullInspect.samples.length+
   fault.recoveredFullInspect.samples.length+
   fault.afterBackendRestartFullInspect.samples.length,
  actualPostgresBackendKilledAndRecovered:true,
  archiveFiles:files,
  fullOriginalRawFilesRead:true,
  independentExternalOperatorSignoff:false,
  productionSloCertified:false}));
}catch(error){
 console.error(JSON.stringify({event:'ei_e48b_raw_evidence_independent_recheck',
  status:'failed',code:String(error?.message??'UNKNOWN').slice(0,120)}));
 process.exitCode=1;
}
