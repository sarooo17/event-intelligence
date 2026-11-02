// E47-C: read-only, independent raw campaign consistency gate.
// This module DOES NOT attest a deployed provider, operator or production SLO.
// It accepts original byte strings from source, host and EI observers; never
// builds its own expected receipts or treats self-reported "passed" as proof.
import {createHash} from 'node:crypto';

export const E47C_SCHEMA='ei.e47c.source-linked-campaign.v1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const hex64=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const identity=s=>typeof s==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,159}$/.test(s);
const nonnegative=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const positive=x=>Number.isSafeInteger(x)&&x>0;
const STAGES=[1000,10000,100000];

function readRaw(files,entry,kind,missing){
 if(!entry||typeof entry.file!=='string'||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.jsonl$/.test(entry.file)||
    !hex64(entry.sha256)){
   missing.push(kind+':invalid-artifact-reference');return null;
 }
 const content=files?.[entry.file];
 if(typeof content!=='string'||Buffer.byteLength(content)>32*1024*1024||
    hash(content)!==entry.sha256){
   missing.push(kind+':artifact-bytes-or-sha256-mismatch');return null;
 }
 if(!content.endsWith('\n')||content.includes('\r')||!content.trim()){
   missing.push(kind+':raw-jsonl-boundary');return null;
 }
 try{
  const lines=content.slice(0,-1).split('\n');
  if(lines.length>100000)throw Error('too-many-rows');
  return lines.map(line=>{
   const row=JSON.parse(line);
   if(!row||typeof row!=='object'||Array.isArray(row))throw Error('invalid-json-row');
   return row;
  });
 }catch{
  missing.push(kind+':invalid-jsonl');return null;
 }
}
function pctl(series,ratio){
 const sorted=[...series].sort((a,b)=>a-b);
 return Math.round(sorted[Math.ceil(sorted.length*ratio)-1]*1000)/1000;
}
function correctClaims(samples,claimed,name,missing){
 for(const [field,measure] of Object.entries({p50:.5,p95:.95,p99:.99})){
  const v=claimed?.[field];
  if(!nonnegative(v)||Math.abs(v-pctl(samples,measure))>0.001)
   missing.push(name+':incorrect-or-censored-'+field);
 }
}
function evaluateStage(stage,files,serviceIds,seenEvents,seenWakeIds,seenReceipts,missing){
 const prefix='stage:'+String(stage?.triggerCount)+':'+String(stage?.requestedRatePerSecond);
 if(!STAGES.includes(stage?.triggerCount)||!positive(stage?.requestedRatePerSecond)||
    !nonnegative(stage?.durationSeconds)||stage.durationSeconds<60||
    !positive(stage?.expectedEventCount)||stage.expectedEventCount<1000||
    !nonnegative(stage?.postgres?.cpuUserMicros)||
    !nonnegative(stage?.postgres?.ioReadBlocks)||
    !nonnegative(stage?.postgres?.ioHitBlocks)||
    !nonnegative(stage?.postgres?.storageBytes)||
    !nonnegative(stage?.rssPeakBytes)||stage.rssPeakBytes<=0){
  missing.push(prefix+':invalid-cardinality-rate-runtime-or-database-metrics');
 }
 const source=readRaw(files,stage?.sourceRaw,prefix+':source',missing);
 const host=readRaw(files,stage?.hostRaw,prefix+':host',missing);
 const observed=readRaw(files,stage?.eiRaw,prefix+':ei',missing);
 if(!source||!host||!observed)return {prefix,readable:false};
 const expected=stage?.expectedEventCount;
 if(source.length!==expected||host.length!==expected||observed.length!==expected)
  missing.push(prefix+':raw-row-count-vs-expected-event-budget');
 const sourceMap=new Map(),hostMap=new Map(),sampleMap=new Map(),seqs=new Set();
 for(const row of source){
  if(!identity(row.eventId)||!positive(row.sourceSequence)||seqs.has(row.sourceSequence)||
     sourceMap.has(row.eventId)||seenEvents.has(row.eventId))
    missing.push(prefix+':source-id-sequence-or-replay');
  else {sourceMap.set(row.eventId,row);seqs.add(row.sourceSequence);seenEvents.add(row.eventId);}
 }
 for(const row of host){
  if(!identity(row.eventId)||!identity(row.wakeId)||!identity(row.runtimeReceiptId)||
     hostMap.has(row.eventId)||seenWakeIds.has(row.wakeId)||seenReceipts.has(row.runtimeReceiptId))
    missing.push(prefix+':invalid-or-duplicate-host-receipt');
  else {hostMap.set(row.eventId,row);seenWakeIds.add(row.wakeId);seenReceipts.add(row.runtimeReceiptId);}
 }
 const workers=new Set(),latency={ingestToMatch:[],matchToWake:[],endToEnd:[]};
 for(const row of observed){
  if(!identity(row.eventId)||!identity(row.workerId)||!serviceIds.has(row.workerId)||
     !identity(row.wakeId)||!identity(row.runtimeReceiptId)||
     !nonnegative(row.ingestToMatchMs)||!nonnegative(row.matchToWakeMs)||
     !nonnegative(row.endToEndMs)||sampleMap.has(row.eventId)){
    missing.push(prefix+':invalid-ei-raw-sample');continue;
  }
  sampleMap.set(row.eventId,row);workers.add(row.workerId);
  latency.ingestToMatch.push(row.ingestToMatchMs);
  latency.matchToWake.push(row.matchToWakeMs);
  latency.endToEnd.push(row.endToEndMs);
 }
 if(workers.size<2)missing.push(prefix+':no-two-distinct-worker-observations');
 for(const [eventId,sourceRow] of sourceMap){
  const h=hostMap.get(eventId),e=sampleMap.get(eventId);
  if(!h||!e||h.wakeId!==e.wakeId||
     h.runtimeReceiptId!==e.runtimeReceiptId||
     sourceRow.eventId!==e.eventId){
   missing.push(prefix+':source-ei-host-lineage-disagreement');break;
  }
 }
 if(sourceMap.size!==hostMap.size||sourceMap.size!==sampleMap.size||
    [...hostMap.keys()].some(id=>!sourceMap.has(id))||
    [...sampleMap.keys()].some(id=>!sourceMap.has(id)))
  missing.push(prefix+':unaccounted-extra-or-missing-event');
 if(stage?.duplicateHostEffects!==0||stage?.unsettledWakeCount!==0)
  missing.push(prefix+':duplicate-effect-or-unsettled-wake');
 for(const [kind,samples] of Object.entries(latency)){
  if(samples.length!==expected){missing.push(prefix+':censored-'+kind);continue;}
  correctClaims(samples,stage?.latency?.[kind],prefix+':'+kind,missing);
 }
 return {prefix,readable:true,sourceRows:source.length,hostRows:host.length,
   eiRows:observed.length,workers:[...workers].sort()};
}

export function assessE47CSourceLinkedEvidence({manifest,files}={}){
 const missing=[];
 if(manifest?.schema!==E47C_SCHEMA)missing.push('schema');
 if(!/^[a-f0-9]{40}$/.test(manifest?.sourceCommitSha??''))missing.push('pinned-source-sha');
 if(manifest?.provider?.kind!=='deployed-mcp-events-source'||
    !identity(manifest?.provider?.serviceId)||
    !identity(manifest?.provider?.deploymentId)||
    !hex64(manifest?.provider?.oracleSourceLogSha256))
  missing.push('independently-deployed-source-and-oracle');
 if(manifest?.host?.kind!=='separately-deployed-host'||
    !identity(manifest?.host?.serviceId)||
    !identity(manifest?.host?.deploymentId)||
    manifest.host?.serviceId===manifest.provider?.serviceId)
  missing.push('separate-host-failure-domain');
 const workers=Array.isArray(manifest?.workers)?manifest.workers:[];
 const workerIds=new Set(workers.map(x=>x?.id));
 if(workers.length!==2||workerIds.size!==2||
    workers.some(x=>!identity(x?.id)||!identity(x?.deploymentId)||!identity(x?.serviceId))||
    workers.some(x=>x.serviceId===manifest?.host?.serviceId||x.serviceId===manifest?.provider?.serviceId))
  missing.push('two-independent-pg-worker-processes');
 const stages=Array.isArray(manifest?.stages)?manifest.stages:[];
 if(stages.length!==6||stages.some(x=>!x||typeof x!=='object'))missing.push('six-tier-rate-matrix');
 const keys=new Set(),rates=new Map(STAGES.map(n=>[n,new Set()]));
 const seenEvents=new Set(),seenWakeIds=new Set(),seenReceipts=new Set(),evidence=[];
 for(const stage of stages.slice(0,30)){
  const key=String(stage?.triggerCount)+':'+String(stage?.requestedRatePerSecond);
  if(keys.has(key))missing.push('duplicate-stage:'+key);
  keys.add(key);
  if(rates.has(stage?.triggerCount)&&positive(stage?.requestedRatePerSecond))
   rates.get(stage.triggerCount).add(stage.requestedRatePerSecond);
  evidence.push(evaluateStage(stage,files,workerIds,seenEvents,seenWakeIds,seenReceipts,missing));
 }
 for(const [tier,list] of rates)if(list.size!==2)missing.push('missing-two-rates-for-'+tier);
 const unique=[...new Set(missing)];
 return Object.freeze({
  schema:'ei.e47c.independent-raw-assessment.v1',
  status:unique.length?'blocked':'consistent-requires-independent-review',
  // Byte-level consistency is NOT independent proof of business truth.
  acceptanceVerified:false,productionSloCertified:false,
  sourceAuthenticityIndependentlyAttested:false,
  exactPhysicalPgIoPerRequestProven:false,
  independentOperatorSignoffRequired:true,
  stageEvidence:evidence,missing:unique,
 });
}
