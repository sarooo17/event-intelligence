#!/usr/bin/env node
// E48-A operator-controlled real TCP/HTTP failure injection between an
// independently deployed first-party MCP source and host PostgreSQL state.
// No production host, vendor API or public domain is involved.
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,open,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {PostgresEventStore} from '../lib/postgres-event-store.mjs';
import {TriggerInspector} from '../lib/trigger-inspector.mjs';
import {verifyStandaloneOracle} from './standalone-mcp-source-oracle.mjs';
import {parsePrivateServiceUrl} from './common.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const required=k=>{const v=process.env[k];if(!v)throw Error('MISSING_'+k);return v;};
const source=parsePrivateServiceUrl(required('EI_LIVE_SOURCE_URL'),'EI_LIVE_SOURCE_URL');
const sourceToken=required('EI_LIVE_SOURCE_TOKEN');
const publicPem=required('EI_SOURCE_TRUSTED_PUBLIC_KEY_PEM').replace(/\\n/g,'\n');
if(hash(publicPem)!==required('EI_SOURCE_TRUSTED_PUBLIC_KEY_SHA256'))
 throw Error('UNTRUSTED_PROVIDER_KEY');
const scope=required('EI_SOURCE_SCOPE_ID'),connectionId=required('EI_SOURCE_CONNECTION_ID');
const eventName=required('EI_SOURCE_EVENT_NAME'),serverId=required('EI_SOURCE_SERVER_ID');
const sourceKeyDigest=required('EI_SOURCE_KEY_DIGEST');
if(sourceKeyDigest!==hash(connectionId+'::'+eventName+'::{}'))
 throw Error('SOURCE_GENESIS_NOT_HOST_CANONICAL');
const prefix=required('EI_TABLE_PREFIX');
const evidenceRoot=required('EI_E48_PRIVATE_EVIDENCE_DIR');
const pool=new pg.Pool({connectionString:required('DATABASE_URL'),max:3,
 connectionTimeoutMillis:5000,statement_timeout:15000});
const sourceSpec={connectionId,serverId,eventName,arguments:{}};
const run=randomUUID(),triggerId='e48-http-fault-'+run;
const start=Date.now(),time=n=>new Date(start+n).toISOString();
const partial={
 protocolVersion:'0.2.0',schemaVersion:'trigger.v0.2',
 matchId:'candidate-'+run,triggerId,triggerVersion:'1',
 status:'partial',partitionKey:null,
 openedAt:time(-160000),updatedAt:time(-159000),expiresAt:time(-100000),
 sourceEvents:[{clauseId:'anchor',traceId:'redacted',sourceEventId:'anchor-'+run,
  eventName:'anchor.ok',serverId:'test-anchor',occurredAt:time(-160000),data:{}}],
 semanticDecision:null,firedWakeId:null,derivedEventIds:[],
 patternState:{version:'2',role:'buffer',maxObservedOccurredAt:time(-160000),
  semanticDecisions:[]},
};
const definition={triggerId,version:'1',
 clauses:[{id:'anchor',serverId:'test-anchor',event:'anchor.ok',where:[]},
 {id:'changed',serverId,event:eventName,where:[]}],
 pattern:{version:'2',root:{kind:'allOf',children:[
  {kind:'event',ref:'anchor'},{kind:'event',ref:'changed'}]}},
 withinMs:60000,target:{runtime:'host',kind:'task',id:'e48-fault'},
};
const db=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
 tablePrefix:prefix,scopeId:scope});
const inspector=()=>new TriggerInspector({store:db,inspectionWindowLimit:3,
 evidenceRefLimit:3,matchHistoryLimit:3}).inspect({
 triggerId,version:'1',matchId:partial.matchId});
let mode='healthy';let server,temporary;
const evidence={};
const sourcePost=async(path,body)=>{
 const r=await fetch(source+path,{method:'POST',
  headers:{authorization:'Bearer '+sourceToken,'content-type':'application/json'},
  body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 const json=await r.json().catch(()=>({}));
 if(r.status!==200)throw Error('UPSTREAM_'+path.replace(/[^a-z0-9]/gi,'_')+'_'+r.status);
 return json;
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 await db.init();
 await db.putTrigger(definition);
 await db.setTriggerState(triggerId,'1','active',null,
  {connectionIds:[connectionId],owner:{type:'user',principal_id:scope,tenant_id:scope}});
 await db.putEventSource({sourceId:'bound-source',...sourceSpec,
  enabled:true,delivery:['poll']});
 await db.appendTriggerMatch(partial);
 await db.putMcpClientState({...sourceSpec,sourceAvailability:'available'});
 if((await inspector()).diagnosisV2.kind==='candidate_impossible')
  throw Error('UNPROVEN_SOURCE_PREMATURE_TERMINAL');
 // Generate two unique, provably durable event occurrences on the
 // separately deployed provider and capture a signed live source seal.
 for(let i=0;i<2;i++){
  await sleep(20);
  const item=await sourcePost('/control/append',{
   eventId:'e48-http-fault-'+run+'-'+i,data:{kind:'synthetic-fault',seq:i}});
  if(item.accepted!==true)throw Error('SOURCE_APPEND_FAILED');
 }
 await sleep(20);
 await sourcePost('/control/seal',{});
 const frontier=await sourcePost('/frontier',{completenessRevision:1});
 const archive=await sourcePost('/control/operator-archive',{});
 const original=Buffer.from(archive.base64??'','base64');
 if(archive.bytes!==original.length||archive.sha256!==hash(original)||
    archive.sourceLog.head!==frontier.sourceLog.head)
  throw Error('REAL_SOURCE_ARCHIVE_MISMATCH');
 temporary=await mkdtemp(join(tmpdir(),'ei-e48-wire-'));
 const sourceFile=join(temporary,'source.jsonl');
 await writeFile(sourceFile,original,{mode:0o600});
 const oracle=await verifyStandaloneOracle({
  logPath:sourceFile,sourceLog:archive.sourceLog,
  attestation:frontier.attestation,publicKeyPem:publicPem,
  expected:{scopeId:scope,sourceKeyDigest,connectionId,serverId,eventName,
   argumentsCanonical:'{}',completenessRevision:1},now:Date.now()});
 if(!oracle.valid||!oracle.events.some(e=>e.eventId==='e48-http-fault-'+run+'-0')||
    !oracle.events.some(e=>e.eventId==='e48-http-fault-'+run+'-1'))
  throw Error('SOURCE_ORACLE_EVENT_COUNT_DISAGREES');
 // The following is a REAL HTTP server and socket (not a mocked JS
 // result). It forwards the deployed provider's actual MCP poll, then
 // intentionally damages the transport response based on operator mode.
 server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/rpc'){
   res.writeHead(404);res.end();return;
  }
  let bytes=0;const chunks=[];
  for await(const chunk of req){
   bytes+=chunk.length;
   if(bytes>8192){res.writeHead(413);res.end();return;}
   chunks.push(chunk);
  }
  if(mode==='disconnect'){res.destroy();return;}
  if(mode==='delay')await sleep(1500);
  try{
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   const upstream=await sourcePost('/rpc',body);
   if(!Array.isArray(upstream?.result?.events)||body.method!=='events/poll')
    throw Error('UPSTREAM_POLL_MALFORMED');
   const result={...upstream.result};
   if(mode==='truncated'){result.truncated=true;result.events=[];
     result.hasMore=false;}
   if(mode==='missing'){result.events=[];result.hasMore=false;
     result.truncated=false;}
   if(mode==='reordered'){result.events=[...result.events].reverse();}
   res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
   res.end(JSON.stringify({...upstream,result}));
  }catch{res.writeHead(502);res.end(JSON.stringify({error:'fault-proxy-upstream-failed'}));}
 });
 await new Promise((resolve,reject)=>{
  server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
 });
 const endpoint='http://127.0.0.1:'+server.address().port+'/rpc';
 const poll=async(timeoutMs=3000)=>{
  const resp=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method:'events/poll',
    params:{cursor:'source-v1:0',maxEvents:256}}),
   signal:AbortSignal.timeout(timeoutMs)});
  if(resp.status!==200)throw Error('PROXY_NON_200');
  return (await resp.json()).result;
 };
 mode='healthy';
 const healthy=await poll();
 const ids=healthy.events.map(x=>x.eventId);
 for(const suffix of ['-0','-1'])
  if(!ids.includes('e48-http-fault-'+run+suffix))
   throw Error('GOOD_TRANSPORT_MISSED_REAL_SOURCE_EVENT');
 evidence.healthyPollOverTcp=true;
 mode='reordered';const reordered=await poll();
 if(reordered.events.length<2||reordered.events[0].eventId===healthy.events[0].eventId)
  throw Error('REORDER_INJECTION_NOT_OBSERVED');
 evidence.outOfOrderActualHttpResponse=true;
 mode='missing';
 const missing=await poll();
 if(missing.events.length!==0||missing.truncated!==false||
    !oracle.events.some(x=>x.eventId==='e48-http-fault-'+run+'-0'))
  throw Error('MISSING_RESPONSE_WAS_NOT_DETECTED_BY_ORACLE');
 evidence.missingOccurrenceComparedToRawOracle=true;
 mode='truncated';
 const gap=await poll();
 if(gap.truncated!==true||gap.events.length!==0)
  throw Error('LIVE_TCP_TRUNCATION_NOT_OBSERVED');
 await db.putMcpClientState({...sourceSpec,sourceAvailability:'available',
  truncated:gap.truncated});
 const unresolved=await inspector();
 if(unresolved.diagnosisV2.kind!=='source_gap_unresolved')
  throw Error('PG_INSPECTOR_DID_NOT_FAIL_CLOSED_ON_HTTP_GAP');
 evidence.pgGapUnresolvedOnTruncatedWireResponse=true;
 mode='disconnect';
 let disconnected=false;
 try{await poll(1000);}catch{disconnected=true;}
 if(!disconnected)throw Error('REAL_TCP_DISCONNECT_NOT_DETECTED');
 await db.putMcpClientState({...sourceSpec,sourceAvailability:'unavailable'});
 if((await inspector()).diagnosisV2.kind==='candidate_impossible')
  throw Error('PROVIDER_OUTAGE_UPGRADED_TO_TERMINAL');
 evidence.realTcpDisconnectDeniedTerminal=true;
 mode='delay';
 let timedOut=false;
 try{await poll(200);}catch(e){timedOut=e?.name==='TimeoutError'||e?.name==='AbortError';}
 if(!timedOut)throw Error('REAL_HTTP_DELAY_NOT_TIMEOUT');
 evidence.realHttpDelayTimeout=true;
 // Explicit PG source state remains UNKNOWN while this independent
 // source's own signer is valid: no magical proof based on a cursor.
 if((await inspector()).diagnosisV2.kind==='candidate_impossible')
  throw Error('UNVERIFIED_PROVIDER_FINALITY');
 // Persist privately raw source+PG redacted evidence off the source
 // service on an independent runner volume, never to public Actions logs.
 const mount=await stat(evidenceRoot);
 if(!mount.isDirectory())throw Error('PRIVATE_EVIDENCE_VOLUME_NOT_READY');
 const folder=join(evidenceRoot,'e48-'+run);
 await (await import('node:fs/promises')).mkdir(folder,{mode:0o700});
 const sourceOutput=join(folder,'source-original.jsonl');
 const file=await open(sourceOutput,'wx',0o600);
 try{await file.writeFile(original);await file.sync();}finally{await file.close();}
 const state=await db.getMcpClientState(connectionId,eventName,{});
 const report={schema:'ei.e48.transport-evidence.v1',sourceCommit:required('EI_LIVE_SOURCE_SHA'),
  runId:run,triggerId,sourceScopeDigest:hash(scope),
  sourceHeadSha256:archive.sourceLog.head,sourceRawSha256:archive.sha256,
  sourceSequence:archive.sourceLog.sequence,
  sourceEventCount:oracle.eventCount,
  signedClaimDigest:hash(frontier.attestation.payload),
  inspectorReason:unresolved.diagnosisV2.kind,
  pgState:{completenessRevision:state.completenessRevision,
   truncated:state.truncated,sourceAvailability:state.sourceAvailability,
   gapUnresolved:state.gapUnresolved},
  tests:evidence,realProviderProcessRestart:false,
  inducedTransportFaults:true,independentEnterpriseSource:false};
 const reportBytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
 const reportFile=await open(join(folder,'pg-inspector-evidence.json'),'wx',0o600);
 try{await reportFile.writeFile(reportBytes);await reportFile.sync();}finally{await reportFile.close();}
 const dirfd=await open(folder,'r');
 try{await dirfd.sync();}finally{await dirfd.close();}
 console.log(JSON.stringify({event:'ei_e48_real_http_faults',status:'passed',
  sourceCommit:report.sourceCommit,
  sourceArchiveSha256:archive.sha256,pgEvidenceSha256:hash(reportBytes),
  sourceHeadSha256:archive.sourceLog.head,sourceEventCount:oracle.eventCount,
  faultCases:evidence,archivePersisted:true,
  rawEvidenceNotPublished:true,
  realProviderProcessRestart:false,transportFaultsReal:true,
  certifiedIndependentHost:false}));
}catch(error){
 console.error(JSON.stringify({event:'ei_e48_real_http_faults',
  status:'failed',code:String(error?.code??error?.message??'UNKNOWN').slice(0,140)}));
 process.exitCode=1;
}finally{
 mode='healthy';
 if(server)await new Promise(resolve=>server.close(()=>resolve()));
 if(temporary)await rm(temporary,{recursive:true,force:true}).catch(()=>{});
 await pool.end().catch(()=>{});
}
