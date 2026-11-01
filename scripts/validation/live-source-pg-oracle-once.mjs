#!/usr/bin/env node
// One-shot, private Railway staging E48-A witness. Never publish source
// fixture payloads, source operator token, Postgres URL or signed raw archive.
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {PostgresEventStore} from '../lib/postgres-event-store.mjs';
import {verifyStandaloneOracle} from './standalone-mcp-source-oracle.mjs';

const {Pool}=pg;
const digest=x=>createHash('sha256').update(x).digest('hex');
function requireEnv(name){
 const v=process.env[name];
 if(!v||!String(v).trim())throw new Error('MISSING_CONFIG_'+name);
 return v;
}
const env={
 sourceUrl:requireEnv('EI_LIVE_SOURCE_URL').replace(/\/$/,''),
 sourceToken:requireEnv('EI_LIVE_SOURCE_TOKEN'),
 workerA:requireEnv('EI_LIVE_WORKER_A_URL').replace(/\/$/,''),
 workerB:requireEnv('EI_LIVE_WORKER_B_URL').replace(/\/$/,''),
 workerToken:requireEnv('EI_LIVE_WORKER_TOKEN'),
 baseScope:requireEnv('EI_LIVE_BASE_SCOPE'),
 databaseUrl:requireEnv('DATABASE_URL'),
 tablePrefix:requireEnv('EI_TABLE_PREFIX'),
 publicKey:requireEnv('EI_SOURCE_TRUSTED_PUBLIC_KEY_PEM').replace(/\\n/g,'\n'),
 sourceScope:requireEnv('EI_SOURCE_SCOPE_ID'),
 sourceKeyDigest:requireEnv('EI_SOURCE_KEY_DIGEST'),
 sourceConnectionId:requireEnv('EI_SOURCE_CONNECTION_ID'),
 sourceServerId:requireEnv('EI_SOURCE_SERVER_ID'),
 sourceEventName:requireEnv('EI_SOURCE_EVENT_NAME'),
 sourceArguments:requireEnv('EI_SOURCE_ARGUMENTS_CANONICAL'),
};
const expectedPublicKeySha256=requireEnv('EI_SOURCE_TRUSTED_PUBLIC_KEY_SHA256');
if(digest(env.publicKey)!==expectedPublicKeySha256)
 throw new Error('PINNED_SOURCE_PUBLIC_KEY_MISMATCH');
if(!/^https?:\/\//.test(env.sourceUrl)||
   !env.sourceUrl.includes('.railway.internal')||
   !env.workerA.includes('.railway.internal')||
   !env.workerB.includes('.railway.internal'))
 throw new Error('LIVE_VALIDATION_PRIVATE_NETWORK_REQUIRED');
const pool=new Pool({connectionString:env.databaseUrl,max:3,
 connectionTimeoutMillis:5000,statement_timeout:15000});
const run=randomUUID(),scope=env.baseScope+':'+run;
const triggerId='source-oracle-'+run;
const eventId='source-oracle-event-'+run;
const traceId='source-oracle-trace-'+run;
const request=async(base,path,input,token,expect=200)=>{
 const response=await fetch(base+path,{method:'POST',headers:{
  authorization:'Bearer '+token,'content-type':'application/json'},
  body:JSON.stringify(input),signal:AbortSignal.timeout(20000)});
 const json=await response.json().catch(()=>({}));
 if(response.status!==expect)throw new Error('HTTP_'+path.replace(/[^a-zA-Z0-9]/g,'_')+'_'+response.status);
 return json;
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let dir=null;
try{
 await pool.query('SELECT 1');
 const source=env.sourceUrl,control=env.sourceToken;
 const list=await request(source,'/rpc',{jsonrpc:'2.0',id:1,method:'events/list'},control);
 if(list?.result?.events?.[0]?.name!==env.sourceEventName)
   throw Error('SOURCE_CATALOG_IDENTITY_MISMATCH');
 const trigger={triggerId,version:'1',
  clauses:[{id:'changed',serverId:env.sourceServerId,
    event:env.sourceEventName,arguments:{},where:[]}],
  pattern:{version:'2',root:{kind:'event',ref:'changed'}},
  withinMs:60000,lifecycle:{oneShot:false,cooldownMs:0,completeOnGoal:false},
  target:{runtime:'ei-validation-host',kind:'benchmark-task',id:'source-oracle-wake'},
 };
 const created=await request(env.workerA,'/v1/triggers/batch',
   {scopeId:scope,triggers:[trigger]},env.workerToken,201);
 if(created.inserted!==1)throw Error('PG_TRIGGER_REGISTRATION_FAILED');
 const reject=await request(source,'/control/append',
   {eventId:'forged-'+run,timestamp:'2000-01-01T00:00:00.000Z'},
   control,400);
 if(reject.error!=='SOURCE_BACKDATED_EVENT_REJECTED')
   throw Error('SOURCE_ACCEPTED_FORGED_EVENT_TIME');
 const appended=await request(source,'/control/append',
   {eventId,data:{fixtureRun:run}},control);
 if(appended.accepted!==true)throw Error('SOURCE_APPEND_NOT_ACCEPTED');
 const duplicate=await request(source,'/control/append',
   {eventId,data:{fixtureRun:run}},control);
 if(duplicate.accepted!==false)throw Error('SOURCE_REPLAY_NOT_DEDUPED');
 await wait(40);
 await request(source,'/control/seal',{},control);
 const polled=await request(source,'/rpc',
   {jsonrpc:'2.0',id:2,method:'events/poll',
    params:{cursor:'source-v1:0',maxEvents:256}},control);
 if(polled.result?.truncated!==false)throw Error('SOURCE_UNEXPECTED_GAP');
 const event=polled.result.events.find(e=>e.eventId===eventId);
 if(!event||event.timestamp!==appended.event.occurredAt)
   throw Error('SOURCE_EVENT_REPLAY_DISAGREEMENT');
 const input={scopeId:scope,traceId,serverId:env.sourceServerId,event};
 const workerA=await request(env.workerA,'/v1/events',input,env.workerToken);
 if(workerA.matched!==1||workerA.persistedDeliveredWakes!==1)
   throw Error('EI_MATCH_OR_WAKE_COUNT_MISMATCH');
 const workerB=await request(env.workerB,'/v1/events',input,env.workerToken);
 if(workerB.persistedDeliveredWakes!==0)
   throw Error('EI_REPLAY_DUPLICATED_HOST_EFFECT');
 const frontier=await request(source,'/frontier',
   {completenessRevision:1},control);
 const archive=await request(source,'/control/operator-archive',{},control);
 if(archive.schema!=='ei.source-operator-archive.v1'||
    archive.sourceLog.head!==frontier.sourceLog.head||
    archive.sourceLog.sequence!==frontier.sourceLog.sequence||
    archive.bytes>16*1024*1024)
   throw Error('SOURCE_ARCHIVE_CHECKPOINT_MISMATCH');
 const bytes=Buffer.from(archive.base64??'','base64');
 if(bytes.length!==archive.bytes||digest(bytes)!==archive.sha256)
   throw Error('SOURCE_ARCHIVE_BYTES_UNVERIFIED');
 dir=await mkdtemp(join(tmpdir(),'ei-live-source-oracle-'));
 const logPath=join(dir,'source.jsonl');
 await writeFile(logPath,bytes,{mode:0o600});
 const independent=await verifyStandaloneOracle({
   logPath,sourceLog:frontier.sourceLog,
   attestation:frontier.attestation,
   publicKeyPem:env.publicKey,
   expected:{scopeId:env.sourceScope,sourceKeyDigest:env.sourceKeyDigest,
     connectionId:env.sourceConnectionId,serverId:env.sourceServerId,
     eventName:env.sourceEventName,
     argumentsCanonical:env.sourceArguments,completenessRevision:1},
   now:Date.now(),
 });
 const observed=independent.events.find(e=>e.eventId===eventId);
 if(!independent.valid||!observed||observed.timestamp!==event.timestamp)
   throw Error('SOURCE_INDEPENDENT_ORACLE_MISMATCH');
 const store=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
   tablePrefix:env.tablePrefix,scopeId:scope});
 await store.init();
 const matches=await store.listTriggerMatches(triggerId);
 if(matches.length!==1||!Array.isArray(matches[0].sourceEvents)||
    !matches[0].sourceEvents.some(e=>e.sourceEventId===eventId&&e.occurredAt===event.timestamp))
   throw Error('PG_SOURCE_EVENT_LINEAGE_MISMATCH');
 const wakes=await store.countWakeDeliveryStates();
 const receipts=await pool.query(
   'SELECT wake_id,receipt_id,attempt_count FROM ei_validation_host_receipts WHERE scope_id=$1',
   [scope]);
 if(matches.length!==1||wakes.delivered!==1||
    wakes.pending!==0||wakes.deadLetter!==0||
    receipts.rows.length!==1||!receipts.rows[0].receipt_id||
    Number(receipts.rows[0].attempt_count)!==1)
   throw Error('PG_MATCH_WAKE_HOST_RECEIPT_ORACLE_MISMATCH');
 console.log(JSON.stringify({
   event:'ei_e48_oracle_pg_live',status:'passed',
   providerSeparateService:true,sourceAppendIdempotent:true,
   sourceSignedFinalityClaimVerified:true,
   archiveSha256:archive.sha256,
   sourceHeadSha256:independent.sourceHeadHash,
   sourceSequence:independent.sourceSequence,
   oracleSourceEventCount:independent.eventCount,
   providerSignerPublicKeySha256:expectedPublicKeySha256,
   sourceCurrentEventMatched:1,pgMatchCount:matches.length,
   pgDeliveredWakes:wakes.delivered,
   externalHostDurableReceipts:receipts.rows.length,
   hostRetryAttempts:receipts.rows[0].attempt_count,
   sourceOracleComparedToPg:true,
   independentlyOperatedProvider:false,
   independentHumanSecurityCertified:false,
   sourceFaultMatrixComplete:false,
   certification:false,
 }));
}catch(error){
 console.error(JSON.stringify({event:'ei_e48_oracle_pg_live',
   status:'failed',code:String(error?.message??'UNKNOWN').slice(0,120)}));
 process.exitCode=1;
}finally{
 if(dir)await rm(dir,{recursive:true,force:true}).catch(()=>{});
 await pool.end().catch(()=>{});
}
