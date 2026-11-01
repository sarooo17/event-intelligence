#!/usr/bin/env node
// E48-A one-shot against a separately DEPLOYED source with exact host-owned
// PostgreSQL scope, MCP state key and source signature identity.
// No credential, raw source archive or signature is ever logged.
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {PostgresEventStore} from '../lib/postgres-event-store.mjs';
import {TriggerInspector} from '../lib/trigger-inspector.mjs';
import {persistExternallyAttestedFrontier} from './mcp-source-frontier-attestation.mjs';
import {verifyStandaloneOracle} from './standalone-mcp-source-oracle.mjs';
import {parsePrivateServiceUrl} from './common.mjs';
import {verifyLiveFiredSourceLineage} from './verify-live-source-lineage.mjs';

const digest=x=>createHash('sha256').update(x).digest('hex');
const required=k=>{const x=process.env[k];if(!x)throw Error('CONFIG_MISSING_'+k);return x;};
const url=parsePrivateServiceUrl(required('EI_LIVE_SOURCE_URL'),'EI_LIVE_SOURCE_URL');
const worker=parsePrivateServiceUrl(required('EI_LIVE_WORKER_A_URL'),'EI_LIVE_WORKER_A_URL');
const workerB=parsePrivateServiceUrl(required('EI_LIVE_WORKER_B_URL'),'EI_LIVE_WORKER_B_URL');
const sourceToken=required('EI_LIVE_SOURCE_TOKEN');
const workerToken=required('EI_LIVE_WORKER_TOKEN');
const scope=required('EI_SOURCE_SCOPE_ID');
const connectionId=required('EI_SOURCE_CONNECTION_ID');
const eventName=required('EI_SOURCE_EVENT_NAME');
const serverId=required('EI_SOURCE_SERVER_ID');
const sourceKeyDigest=required('EI_SOURCE_KEY_DIGEST');
const privateKeyDigest=required('EI_SOURCE_TRUSTED_PUBLIC_KEY_SHA256');
const publicPem=required('EI_SOURCE_TRUSTED_PUBLIC_KEY_PEM').replace(/\\n/g,'\n');
if(digest(publicPem)!==privateKeyDigest)throw Error('SOURCE_SIGNER_PIN_MISMATCH');
if(sourceKeyDigest!==digest(connectionId+'::'+eventName+'::{}'))
 throw Error('SOURCE_KEY_NOT_HOST_CANONICAL');
const prefix=required('EI_TABLE_PREFIX');
const pool=new pg.Pool({connectionString:required('DATABASE_URL'),max:4,
  connectionTimeoutMillis:7000,statement_timeout:18000});
const request=async (base,path,input,token,status=200)=>{
 const r=await fetch(base+path,{method:'POST',
  headers:{authorization:'Bearer '+token,'content-type':'application/json'},
  body:JSON.stringify(input),signal:AbortSignal.timeout(15000)});
 const data=await r.json().catch(()=>({}));
 if(r.status!==status)throw Error('HTTP_'+path.replace(/[^a-zA-Z0-9]/g,'_')+'_'+r.status);
 return data;
};
const source={connectionId,serverId,eventName,arguments:{}};
const runId=randomUUID(),start=Date.now(),triggerId='e48-candidate-'+runId;
const positiveId='e48-live-wake-'+runId;
const nowIso=offset=>new Date(start+offset).toISOString();
const candidate={
 protocolVersion:'0.2.0',schemaVersion:'trigger.v0.2',
 matchId:'candidate-'+runId,triggerId,triggerVersion:'1',
 status:'partial',partitionKey:null,
 openedAt:nowIso(-180000),updatedAt:nowIso(-179000),
 expiresAt:nowIso(-120000),
 sourceEvents:[{clauseId:'merged',traceId:'fixture-only',sourceEventId:'anchor-'+runId,
  eventName:'pr.merged',serverId:'git',occurredAt:nowIso(-180000),data:{}}],
 semanticDecision:null,firedWakeId:null,derivedEventIds:[],
 patternState:{version:'2',role:'buffer',maxObservedOccurredAt:nowIso(-180000),
  semanticDecisions:[]},
};
const definition={
 triggerId,version:'1',clauses:[
  {id:'merged',serverId:'git',event:'pr.merged',where:[]},
  {id:'changed',serverId,event:eventName,where:[]}],
 pattern:{version:'2',root:{kind:'allOf',children:[
  {kind:'event',ref:'merged'}, {kind:'event',ref:'changed'}]}},
 withinMs:60000,target:{runtime:'host',kind:'task',id:'e48-fault-test'},
};
const db=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
 tablePrefix:prefix,scopeId:scope});
const foreign=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
 tablePrefix:prefix,scopeId:scope+'-foreign'});
const inspect=store=>new TriggerInspector({store,inspectionWindowLimit:3,
 evidenceRefLimit:3,matchHistoryLimit:3}).inspect({
  triggerId,version:'1',matchId:candidate.matchId});
let temp=null;
try{
 await db.init();await foreign.init();
 for(const [store,tenant] of [[db,scope],[foreign,scope+'-foreign']]){
  await store.putTrigger(definition);
  await store.setTriggerState(triggerId,'1','active',null,
   {connectionIds:[connectionId],
    owner:{type:'user',principal_id:tenant,tenant_id:tenant}});
  await store.putEventSource({sourceId:'e48-source',...source,
   enabled:true,delivery:['poll']});
  await store.appendTriggerMatch(candidate);
  await store.putMcpClientState({...source,sourceAvailability:'available'});
 }
 const initial=await db.getMcpClientState(connectionId,eventName,{});
 if(initial.completenessRevision!==1)
  throw Error('FRESH_PG_SOURCE_REVISION_NOT_ONE');
 if((await inspect(db)).diagnosisV2.kind!=='not_yet_satisfied')
  throw Error('UNSIGNED_CANDIDATE_TERMINAL');
 const initialStatus=await request(url,'/status',{},sourceToken);
 if(initialStatus.revoked!==false||initialStatus.revision!==1||
    initialStatus.lastSeal!==null)
  throw Error('DEDICATED_SOURCE_NOT_PRISTINE');
 // An actually DEPLOYED source seals its real append-only log, whose
 // genesis is bound to this exact PostgreSQL tenant/source key.
 await new Promise(r=>setTimeout(r,20));
 await request(url,'/control/seal',{},sourceToken);
 const proof=await request(url,'/frontier',
  {completenessRevision:initial.completenessRevision},sourceToken);
 const archive=await request(url,'/control/operator-archive',{},sourceToken);
 const raw=Buffer.from(archive.base64??'','base64');
 if(raw.length!==archive.bytes||digest(raw)!==archive.sha256||
    archive.sourceLog.head!==proof.sourceLog.head)
   throw Error('RAW_SOURCE_ARCHIVE_CHECKPOINT_INVALID');
 temp=await mkdtemp(join(tmpdir(),'ei-e48-signed-bound-'));
 const log=join(temp,'source.jsonl');
 await writeFile(log,raw,{mode:0o600});
 const oracle=await verifyStandaloneOracle({logPath:log,
  sourceLog:proof.sourceLog,attestation:proof.attestation,
  publicKeyPem:publicPem,expected:{scopeId:scope,sourceKeyDigest,
   connectionId,serverId,eventName,argumentsCanonical:'{}',
   completenessRevision:initial.completenessRevision},now:Date.now()});
 if(!oracle.valid||oracle.eventCount!==0)
  throw Error('UNEXPECTED_PRE_EXISTING_SOURCE_OCCURRENCES');
 // The live source signature is checked by the actual host code and
 // stored in PG only for this source and scope; other scope denied.
 const args={
  source,expectedCompletenessRevision:initial.completenessRevision,
  trustedPublicKeyPem:publicPem,attestation:proof.attestation,
  sourceCompletenessContractIndependentlyVerified:true,
 };
 let foreignRejected=false;
 try{await persistExternallyAttestedFrontier({store:foreign,...args});}
 catch(e){foreignRejected=e?.code==='EVENT_INTELLIGENCE_UNVERIFIED_SOURCE_FRONTIER';}
 if(!foreignRejected)throw Error('FOREIGN_SCOPE_SOURCE_PROOF_ACCEPTED');
 if((await inspect(foreign)).diagnosisV2.kind!=='not_yet_satisfied')
  throw Error('FOREIGN_SCOPE_TERMINAL');
 await persistExternallyAttestedFrontier({store:db,...args});
 const terminal=await inspect(db);
 if(terminal.diagnosisV2.kind!=='candidate_impossible'||
    terminal.diagnosisV2.scope!=='selected_match'||
    terminal.diagnosisV2.upstreamCompleteness!=='unknown')
   throw Error('SELECTED_SOURCE_IMPOSSIBILITY_FAILED');
 // A real post-seal event is later observed through the source's live
 // MCP Events poll, matched by an EI worker and durably receipted.
 const positive={
  triggerId:positiveId,version:'1',
  clauses:[{id:'changed',serverId,event:eventName,arguments:{},where:[]}],
  pattern:{version:'2',root:{kind:'event',ref:'changed'}},withinMs:60000,
  lifecycle:{oneShot:false,cooldownMs:0,completeOnGoal:false},
  target:{runtime:'ei-validation-host',kind:'benchmark-task',id:'e48-bound-event'},
 };
 const reg=await request(worker,'/v1/triggers/batch',
  {scopeId:scope,triggers:[positive]},workerToken,201);
 if(reg.inserted!==1)throw Error('WORKER_LIVE_TRIGGER_FAILED');
 await new Promise(r=>setTimeout(r,20));
 const eventId='e48-bound-event-'+runId;
 const appended=await request(url,'/control/append',
  {eventId,data:{fixtureRun:runId}},sourceToken);
 if(appended.accepted!==true)throw Error('POST_SEAL_APPEND_FAILED');
 const poll=(await request(url,'/rpc',{jsonrpc:'2.0',id:2,method:'events/poll',
  params:{cursor:'source-v1:0',maxEvents:10}},sourceToken)).result;
 if(poll.truncated!==false||poll.events.length!==1||
    poll.events[0].eventId!==eventId)
  throw Error('LIVE_SOURCE_POLL_MISMATCH');
 const ev=poll.events[0],req={scopeId:scope,
  traceId:'bound-'+runId,serverId,event:ev};
 const one=await request(worker,'/v1/events',req,workerToken);
 if(one.matched!==1||one.persistedDeliveredWakes!==1)
  throw Error('POST_FRONTIER_WORKER_WAKE_FAILED');
 const two=await request(workerB,'/v1/events',req,workerToken);
 if(two.persistedDeliveredWakes!==0)
  throw Error('POST_FRONTIER_REPLAY_DUPLICATED_WAKE');
 const matches=await db.listTriggerMatches(positiveId);
 const fired=verifyLiveFiredSourceLineage({matches,
  sourceEventId:eventId,sourceEventTimestamp:ev.timestamp});
 const id=fired.record.firedWakeId;
 const host=await pool.query(
  'SELECT wake_id,receipt_id,attempt_count FROM ei_validation_host_receipts WHERE scope_id=$1 AND wake_id=$2',
  [scope,id]);
 const delivery=await db.getWakeDelivery(id);
 if(host.rows.length!==1||delivery?.runtimeReceiptId!==host.rows[0].receipt_id||
   delivery?.status!=='delivered'||Number(host.rows[0].attempt_count)!==1)
   throw Error('LIVE_BOUND_SOURCE_HOST_RECEIPT_FAILED');
 // A new real event must invalidate old PG terminal completeness
 // after the host observes the next source poll revision.
 await db.putMcpClientState({...source,sourceAvailability:'available'});
 const later=await inspect(db);
 if(later.diagnosisV2.kind==='candidate_impossible')
  throw Error('NEW_SOURCE_POLL_KEPT_STALE_TERMINAL');
 let stale=false;try{await persistExternallyAttestedFrontier({store:db,...args});}
 catch(e){stale=e?.code==='EVENT_INTELLIGENCE_STALE_SOURCE_FRONTIER';}
 if(!stale)throw Error('STALE_SOURCE_REVISION_ACCEPTED');
 console.log(JSON.stringify({event:'ei_e48_bound_source_live',
  status:'passed',sourceCommit:required('EI_LIVE_SOURCE_SHA'),
  sourceIdBoundToPg:true,sourceKeyDigestMatchesHost:true,
  signedLiveCandidateImpossible:true,foreignScopeDenied:true,
  pgStaleProofInvalidated:true,sourceOracleVerified:true,
  sourceArchiveSha256:archive.sha256,
  sourceHeadSha256:archive.sourceLog.head,
  pgMatchCount:1,pgWakeCount:1,hostReceiptCount:1,
  duplicateEffects:0,
  sourceFaultMatrixFromOtherRun:true,
  actualTransportOutageOrGap:false,certification:false}));
}catch(error){
 console.error(JSON.stringify({event:'ei_e48_bound_source_live',
  status:'failed',code:String(error?.code??error?.message??'UNKNOWN').slice(0,110)}));
 process.exitCode=1;
}finally{
 if(temp)await rm(temp,{recursive:true,force:true}).catch(()=>{});
 await pool.end().catch(()=>{});
}
