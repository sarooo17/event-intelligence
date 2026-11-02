#!/usr/bin/env node
// Actual full TriggerInspector.inspect() strict-path Railway/PG16 profiler.
// All candidate rows use a NEW isolated PG table prefix, never production.
// Structured samples and PG table/index I/O retained off-host on private volume.
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {mkdir,open,stat} from 'node:fs/promises';
import {join} from 'node:path';
import pg from 'pg';
import {PostgresEventStore} from '../lib/postgres-event-store.mjs';
import {TriggerInspector} from '../lib/trigger-inspector.mjs';
import {parsePrivateServiceUrl} from './common.mjs';
import {safeProfileConfig,profileFullInspector,
 sha256,latencyStatistics} from './e48b-inspector-profile.mjs';

const {Pool}=pg;
const required=k=>{const v=process.env[k];if(!v)throw Error('E48B_CONFIG_MISSING_'+k);return v;};
const config=safeProfileConfig({
 counts:[1000,10000,100000],
 samplesPerPhase:Number(process.env.EI_E48B_SAMPLES??150),
 maxHostEvents:Number(process.env.EI_E48B_HOST_EVENTS??150),
});
const prefix=required('EI_E48B_TABLE_PREFIX');
if(!/^ei_e48b_[a-z0-9_]{0,20}$/.test(prefix))
 throw Error('E48B_REQUIRE_ISOLATED_TABLE_PREFIX');
const dir=required('EI_E48B_ARTIFACT_DIR');
const database=required('DATABASE_URL');
const workerA=parsePrivateServiceUrl(required('EI_E48B_WORKER_A_URL'),'EI_E48B_WORKER_A_URL');
const workerB=parsePrivateServiceUrl(required('EI_E48B_WORKER_B_URL'),'EI_E48B_WORKER_B_URL');
if(workerA===workerB)throw Error('E48B_DISTINCT_WORKER_ENDPOINTS_REQUIRED');
const workerToken=required('EI_E48B_WORKER_TOKEN');
const hostScopeBase=required('EI_E48B_HOST_SCOPE_BASE');
const runId=randomUUID();
const profileScope='e48b-inspection:'+runId;
const pool=new Pool({connectionString:database,max:5,
 connectionTimeoutMillis:5000,statement_timeout:15000});
const store=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
 tablePrefix:prefix,scopeId:profileScope});
const inspector=new TriggerInspector({store,inspectionWindowLimit:8,
 matchHistoryLimit:8,evidenceRefLimit:8});
const fixtureTime=new Date(Date.now()-120000).toISOString();
const pattern={version:'2',root:{kind:'event',ref:'changed'}};
const trigger={triggerId:'e48-inspected',version:'1',clauses:[
 {id:'changed',serverId:'e48b-benchmark',event:'fixture.changed',
  arguments:{},where:[]}],
 pattern,withinMs:60000,target:{runtime:'host',kind:'task',id:'inspector-profile'}};
const sampleMatch={protocolVersion:'0.2.0',
 schemaVersion:'trigger.v0.2',matchId:'candidate-000001',
 triggerId:'e48-inspected',triggerVersion:'1',status:'partial',
 partitionKey:null,openedAt:fixtureTime,updatedAt:fixtureTime,
 expiresAt:fixtureTime,sourceEvents:[],semanticDecision:null,
 firedWakeId:null,derivedEventIds:[],
 patternState:{version:'2',role:'buffer',
  maxObservedOccurredAt:fixtureTime,semanticDecisions:[]}};
const hostRequest=async(base,path,body,status=200)=>{
 const response=await fetch(base+path,{method:'POST',headers:{
  authorization:'Bearer '+workerToken,'content-type':'application/json'},
  body:JSON.stringify(body),signal:AbortSignal.timeout(16000)});
 const out=await response.json().catch(()=>({}));
 if(response.status!==status)
  throw Error('E48B_HOST_HTTP_'+path.replace(/[^a-z0-9]/gi,'_')+'_'+response.status);
 return out;
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const table=prefix+'_records';
const sampleIds=(count)=>{
 const numbers=[1,Math.max(1,Math.floor(count/2)),count,
  Math.max(1,Math.floor(count*.25)),Math.max(1,Math.floor(count*.75))];
 return numbers.map(i=>'candidate-'+String(i).padStart(6,'0'));
};
async function pgStats(){
 // These are cumulative PER-TEST-TABLE/index read counters, not shared
 // database-wide delta masquerading as an individual query's I/O.
 await pool.query('SELECT pg_stat_clear_snapshot()');
 const r=await pool.query(`SELECT relname,coalesce(heap_blks_read,0)::bigint AS disk_reads,
 coalesce(heap_blks_hit,0)::bigint AS cache_hits,
 coalesce(idx_blks_read,0)::bigint AS index_disk_reads,
 coalesce(idx_blks_hit,0)::bigint AS index_cache_hits
 FROM pg_statio_user_tables WHERE relname=$1`,[table]);
 const x=r.rows[0]??{};
 return {relation:table,
  heapDiskReadBlocks:Number(x.disk_reads??0),
  heapCacheHitBlocks:Number(x.cache_hits??0),
  indexDiskReadBlocks:Number(x.index_disk_reads??0),
  indexCacheHitBlocks:Number(x.index_cache_hits??0)};
}
const subtractStats=(a,b)=>({
 heapDiskReadBlocks:b.heapDiskReadBlocks-a.heapDiskReadBlocks,
 heapCacheHitBlocks:b.heapCacheHitBlocks-a.heapCacheHitBlocks,
 indexDiskReadBlocks:b.indexDiskReadBlocks-a.indexDiskReadBlocks,
 indexCacheHitBlocks:b.indexCacheHitBlocks-a.indexCacheHitBlocks,
 note:'PG16 cumulative counters scoped to isolated test table; asynchronously published, not per-inspection physical I/O'
});
async function explainExact(matchId){
 const statement=`SELECT CASE WHEN octet_length(payload::text)<=$5
 THEN payload ELSE NULL END AS payload FROM "${table}"
 WHERE scope_id=$1 AND kind='trigger_match'
 AND payload->>'triggerId'=$2 AND payload->>'triggerVersion'=$3
 AND record_key=$4 LIMIT 1`;
 const args=[profileScope,'e48-inspected','1',matchId,65536];
 const r=await pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+statement,args);
 const entry=r.rows[0]?.['QUERY PLAN']?.[0];
 if(!entry)throw Error('E48B_EXPLAIN_UNAVAILABLE');
 const walk=node=>({
  nodeType:node['Node Type'],relation:node['Relation Name']??null,
  indexName:node['Index Name']??null,actualRows:node['Actual Rows'],
  actualLoops:node['Actual Loops'],
  sharedHitBlocks:node['Shared Hit Blocks']??0,
  sharedReadBlocks:node['Shared Read Blocks']??0,
  children:(node.Plans??[]).map(walk),
 });
 return {sqlDigest:sha256(statement),planningMs:entry['Planning Time'],
  executionMs:entry['Execution Time'],plan:walk(entry.Plan),
  physicallyExecutedPostgresQuery:true};
}
async function populate(from,to){
 for(let start=from;start<=to;start+=4000){
  const end=Math.min(to,start+3999);
  await pool.query(`INSERT INTO "${table}"
   (scope_id,kind,record_key,payload,updated_at)
   SELECT $1,'trigger_match',
   'candidate-'||lpad(g::text,6,'0'),
   jsonb_set($2::jsonb,'{matchId}',
    to_jsonb('candidate-'||lpad(g::text,6,'0')),true),clock_timestamp()
   FROM generate_series($3::integer,$4::integer) AS g
   ON CONFLICT (scope_id,kind,record_key) DO NOTHING`,
   [profileScope,JSON.stringify(sampleMatch),start,end]);
 }
 const r=await pool.query(`SELECT count(*)::integer AS total
 FROM "${table}" WHERE scope_id=$1 AND kind='trigger_match'`,[profileScope]);
 if(r.rows[0]?.total!==to)throw Error('E48B_PERSISTED_CANDIDATE_COUNT_MISMATCH');
}
async function remoteHostLoad(count,stage,{ready}={}){
 const scope=hostScopeBase+':e48b-'+runId+'-'+stage;
 const trig='e48b-remote-'+runId+'-'+stage;
 const def={triggerId:trig,version:'1',clauses:[{
  id:'changed',serverId:'e48b-remote-provider',
  event:'e48b.remote.changed',arguments:{},where:[]}],
  pattern:{version:'2',root:{kind:'event',ref:'changed'}},
  lifecycle:{oneShot:false,cooldownMs:0,completeOnGoal:false},
  withinMs:60000,target:{runtime:'ei-validation-host',
   kind:'benchmark-task',id:'e48b-remote-load'}};
 const made=await hostRequest(workerA,'/v1/triggers/batch',
  {scopeId:scope,triggers:[def]},201);
 if(made.inserted!==1)throw Error('E48B_HOST_TRIGGER_NOT_REGISTERED');
 const r={attempted:0,accepted:0,matched:0,delivered:0,
  refused:0,workerIds:[],latencyMs:[],errors:[],intervals:[]};
 if(ready)ready();
 for(let i=0;i<count;i++){
  const base=i%2===0?workerA:workerB,begin=performance.now();
  r.attempted++;
  try{
   const out=await hostRequest(base,'/v1/events',{
    scopeId:scope,traceId:'e48b-'+runId+'-'+stage+'-'+i,
    serverId:'e48b-remote-provider',
    event:{eventId:'e48b-remote-'+runId+'-'+stage+'-'+i,
     name:'e48b.remote.changed',timestamp:new Date().toISOString(),
     data:{fixtureOrdinal:i}},
   });
   if(typeof out.workerId!=='string'||!out.workerId||
     out.matched!==1||out.persistedDeliveredWakes!==1)
    throw Error('E48B_HOST_WAKE_NOT_DELIVERED');
   r.accepted++;r.matched+=out.matched;
   r.delivered+=out.persistedDeliveredWakes;r.workerIds.push(out.workerId);
  }catch(error){r.refused++;r.errors.push({
   code:String(error?.code??error?.message??'UNKNOWN').slice(0,95)})}
  const end=performance.now();
  r.latencyMs.push(Math.round((end-begin)*1000)/1000);
  r.intervals.push({begin,end});
  await sleep(45);
 }
 const observed=await pool.query(
  'SELECT count(*)::int AS n,count(DISTINCT wake_id)::int AS unique_n,'
  +'count(DISTINCT receipt_id)::int AS receipts'
  +' FROM ei_validation_host_receipts WHERE scope_id=$1',[scope]);
 r.hostReceiptCount=observed.rows[0]?.n??0;
 r.uniqueHostWakes=observed.rows[0]?.unique_n??0;
 r.uniqueHostReceipts=observed.rows[0]?.receipts??0;
 r.distinctWorkerCount=new Set(r.workerIds).size;
 r.latencySummaryMs=latencyStatistics(r.latencyMs);
 delete r.workerIds;delete r.latencyMs;
 if(r.accepted<10||r.distinctWorkerCount!==2||
    r.hostReceiptCount!==r.delivered||
    r.uniqueHostReceipts!==r.hostReceiptCount||
    r.uniqueHostWakes!==r.hostReceiptCount)
  throw Error('E48B_REMOTE_HOST_RECEIPT_RECONCILIATION_FAILED');
 return r;
}
async function faultProbe(id){
 // Real PostgreSQL pool contention with a 550 ms server-side sleep, not
 // an invented slow-query response. Profile FULL inspect under queued
 // connection timeout, then confirm later successful recovery.
 const faultPool=new Pool({connectionString:database,max:1,
  connectionTimeoutMillis:110,statement_timeout:1500});
 const faultStore=new PostgresEventStore({pool:faultPool,
  dispatchPoolIdentity:faultPool,tablePrefix:prefix,scopeId:profileScope});
 const faultInspector=new TriggerInspector({store:faultStore,
  inspectionWindowLimit:8,matchHistoryLimit:8,evidenceRefLimit:8});
 let hold=null,slowStarted=false,backendTerminated=null;
 try{
  hold=await faultPool.connect();
  const sleepQuery=hold.query('SELECT pg_sleep(0.55)')
   .then(()=>{slowStarted=true;}).catch(()=>{slowStarted=false;});
  const queue=await profileFullInspector({inspector:faultInspector,
    ids:[id],iterations:3});
  await sleepQuery;
  hold.release();hold=null;
  const recovery=await profileFullInspector({inspector:faultInspector,
    ids:[id],iterations:3});
  if(queue.refusals<1||recovery.refusals!==0)
   throw Error('E48B_POOL_CONTENTION_RECOVERY_NOT_VERIFIED');
  // Terminate only this separately acquired TEST connection; never other
  // workers or the database primary. The role may lack permission.
  hold=await faultPool.connect();
  const pid=(await hold.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  // node-postgres idle checked-out clients emit *asynchronous* error
  // events on physical backend termination. Catch them explicitly
  // before asking PG to terminate this isolated test backend.
  const clientErrors=[];
  const onClientError=error=>clientErrors.push(String(error?.code??'PG_BACKEND_ENDED'));
  hold.on('error',onClientError);
  try{
   if(Number.isSafeInteger(pid)){
    try{
     const outcome=await pool.query('SELECT pg_terminate_backend($1) AS terminated',[pid]);
     backendTerminated=outcome.rows[0]?.terminated===true;
     if(backendTerminated)await sleep(150);
    }catch{backendTerminated=false;}
   }
  }finally{
   hold.removeListener('error',onClientError);
   hold.release(true);hold=null;
  }
  const afterTermination=await profileFullInspector({inspector:faultInspector,
    ids:[id],iterations:3});
  if(afterTermination.refusals!==0)
   throw Error('E48B_RECOVERY_AFTER_ISOLATED_PG_TERMINATION_FAILED');
  return {serverSidePgSleepMs:550,queuedFullInspect:queue,
    recoveredFullInspect:recovery,
    testOnlyBackendTerminationSucceeded:backendTerminated,
    afterBackendRestartFullInspect:afterTermination,
    PGPrimaryWasNOTRestarted:true};
 }finally{
  if(hold)hold.release(true);
  await faultPool.end().catch(()=>{});
 }
}
let fatal=null,completed=0;const reports=[];
try{
 const volume=await stat(dir);
 if(!volume.isDirectory())throw Error('E48B_PRIVATE_VOLUME_REQUIRED');
 await store.init();await store.putTrigger(trigger);
 await store.setTriggerState('e48-inspected','1','active',null);
 const serverInfo=(await pool.query('SHOW server_version')).rows[0]?.server_version??'unknown';
 const source={sourceSha:required('EI_E48B_SOURCE_SHA'),
  node:process.version,pgVersion:serverInfo,platform:process.platform,
  cpuCores:os.cpus().length,containerized:true,
  railwayService:'ei-e48b-inspector-once',
  sourceKey:'isolated PG16 test prefix',prefix};
 for(const count of config.counts){
  await populate(completed+1,count);completed=count;
  // A small warmup goes through the full Inspector but is deliberately
  // excluded from both reported latency samples and PG I/O deltas.
  await profileFullInspector({inspector,ids:sampleIds(count),iterations:5});
  await sleep(1000);
  const before=await pgStats();
  const baseline=await profileFullInspector({inspector,
   ids:sampleIds(count),iterations:config.samplesPerPhase});
  await sleep(1000);
  const afterBaseline=await pgStats();
  const loadCount=Math.max(10,Math.floor(config.maxHostEvents/3));
  await sleep(100);
  const startAt=new Date().toISOString();
  const beforeHost=await pgStats();
  // Finish remote host trigger registration BEFORE collecting the first
  // Inspector sample; only count latency as under host load when actual
  // remote ingest requests overlap the timed inspection interval.
  let signalReady;
  const hostReady=new Promise(resolve=>{signalReady=resolve});
  const loadPromise=remoteHostLoad(loadCount,String(count),
   {ready:signalReady});
  await hostReady;
  const inspectionStart=performance.now();
  const loaded=await profileFullInspector({inspector,ids:sampleIds(count),
    iterations:config.samplesPerPhase,
    onSample:async()=>{await sleep(20);}});
  const inspectionEnd=performance.now();
  const host=await loadPromise;
  const overlapping=host.intervals.filter(x=>
   x.begin<=inspectionEnd&&x.end>=inspectionStart);
  host.overlappingRequestCount=overlapping.length;
  host.inspectionWindowMs=Math.round((inspectionEnd-inspectionStart)*1000)/1000;
  host.lastOverlappingRequestAgeMs=overlapping.length?
   Math.round((inspectionEnd-Math.max(...overlapping.map(x=>x.end)))*1000)/1000:null;
  // Explicitly reject schedules where registration or a short burst
  // finished before the actual measurement (old Promise.all bug).
  if(overlapping.length<5||
    host.lastOverlappingRequestAgeMs>
      Math.max(1500,host.inspectionWindowMs*.5))
   throw Error('E48B_HOST_LOAD_DID_NOT_OVERLAP_INSPECTION_WINDOW');
  delete host.intervals;
  await sleep(1000);
  const afterHost=await pgStats();
  const exactPlan=await explainExact(sampleIds(count)[2]);
  const newestFailure=await inspector.inspect({
   triggerId:'e48-inspected',version:'1'}).then(
     ()=>({unexpectedSuccess:true}),e=>({code:String(e?.code??'UNKNOWN')}));
  if(newestFailure.unexpectedSuccess||
     newestFailure.code!=='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED')
   throw Error('E48B_NONKEYED_WIDE_CANDIDATE_REFUSAL_MISSING');
  const caseReport={
   candidatePopulation:count,scenario:'pg16-staging-real-inspector',
   startedAt:startAt,finishedAt:new Date().toISOString(),
   persistedCandidatesVerified:true,
   exactKeyedStrictInspection:true,
   allCandidateLatestMatchRefusesSafely:true,
   globalLatestRefusalCode:newestFailure.code,
   baseline,loaded,
   hostConcurrency:{...host,hostIsSeparatelyDeployed:true,
    actualHostEffectReceiptsVerified:true},
   pgReadIO:{
    exclusiveTestRelation:table,
    baselineDelta:subtractStats(before,afterBaseline),
    hostLoadDelta:subtractStats(beforeHost,afterHost),
    explainAnalyzeBuffers:exactPlan,
    pgVersion:serverInfo,
    dbGlobalCountersAreNotPerQuery:true,
    perTestTableCountersAreAsynchronouslyFlushed:true,
   },
  };
  if(baseline.refusals>0||loaded.refusals>0)
   throw Error('E48B_FULL_INSPECTOR_HAS_UNEXPECTED_REFUSALS');
  reports.push(caseReport);
  // Partial artifacts are durable before going to the next cardinality.
  const name=join(dir,'e48b-'+runId+'-'+count+'.json');
  const bytes=Buffer.from(JSON.stringify({config,source,caseReport},null,2)+'\n');
  const handle=await open(name,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
 }
 const fault=await faultProbe(sampleIds(100000)[0]);
 const faultBytes=Buffer.from(JSON.stringify({schema:'ei.e48b.fault.raw.v1',
  runId,sourceSha:source.sourceSha,fault},null,2)+'\n');
 const faultFile=await open(join(dir,'e48b-'+runId+'-fault.json'),'wx',0o600);
 try{await faultFile.writeFile(faultBytes);await faultFile.sync();}
 finally{await faultFile.close();}
 const manifest={schema:'ei.e48b.independent-full-inspector-railway.v1',
  runId,runAt:new Date().toISOString(),config,source,
  candidateCases:reports.map(x=>({
   population:x.candidatePopulation,
   baseline:x.baseline.percentileLatencyMs,
   loaded:x.loaded.percentileLatencyMs,
   baselineRefusals:x.baseline.refusals,
   loadedRefusals:x.loaded.refusals,
   hostReceipts:x.hostConcurrency.hostReceiptCount,
   tableIO:x.pgReadIO,
  })),
  fault:{
   rawArtifactSha256:sha256(faultBytes),
   rawArtifactName:'e48b-'+runId+'-fault.json',
   serverSidePgSleepMs:fault.serverSidePgSleepMs,
   contendedInspectorRefusals:fault.queuedFullInspect.refusals,
   afterSleepRecoveryRefusals:fault.recoveredFullInspect.refusals,
   backendTerminationSucceeded:fault.testOnlyBackendTerminationSucceeded,
   postTerminationRecoveryRefusals:fault.afterBackendRestartFullInspect.refusals,
   postgresPrimaryNeverRestarted:true,
  },
  hostLoadExternal:true,productionSloCertified:false,
  independentOperatorCertification:false,
  statementSpecificPhysicalDiskIOAttributed:false,
  completedStages:reports.length,
 };
 const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
 const file=await open(join(dir,'e48b-'+runId+'-manifest.json'),'wx',0o600);
 try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
 const fd=await open(dir,'r');
 try{await fd.sync();}finally{await fd.close();}
 console.log(JSON.stringify({event:'ei_e48b_full_inspector',
  status:'passed',sourceSha:source.sourceSha,
  measuredCandidates:config.counts,
  observedSampleCount:reports.reduce((n,r)=>n+r.baseline.fullInspectorCalls+
    r.loaded.fullInspectorCalls,0),
  observedHostReceipts:reports.reduce((n,r)=>n+r.hostConcurrency.hostReceiptCount,0),
  p99ByPopulation:reports.map(r=>({
   count:r.candidatePopulation,baseline:r.baseline.percentileLatencyMs.p99,
   underHostLoad:r.loaded.percentileLatencyMs.p99})),
  tableReadIOCollected:true,actualFullInspector:true,
  faultPoolContentionRefusals:manifest.fault.contendedInspectorRefusals,
  isolatedPGBackendTerminationSucceeded:manifest.fault.backendTerminationSucceeded,
  rawArtifactsPersisted:true,manifestSha256:sha256(bytes),
  claimExternalIndependentCertification:false}));
}catch(error){
 fatal=String(error?.code??error?.message??'UNKNOWN').slice(0,140);
 console.error(JSON.stringify({event:'ei_e48b_full_inspector',
  status:'failed',code:fatal,stagesCompleted:completed,
  artifactsForCompletedStages:reports.length}));
 process.exitCode=1;
}finally{
 await pool.end().catch(()=>{});
 // The isolated prefix is retained on failure for operator debugging and
 // re-run; success cleanup is explicit in a separate operator task
 // after artifact verification, never drop shared validation tables.
}
