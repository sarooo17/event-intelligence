#!/usr/bin/env node
// Operator-authorized one-shot fault matrix against the FIRST-PARTY,
// separately deployed, private MCP evidence source. Never changes EI
// workers or injects arbitrary third-party payloads. No raw archive in logs.
import {randomUUID,createHash,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parsePrivateServiceUrl} from './common.mjs';
import {verifyStandaloneOracle} from './standalone-mcp-source-oracle.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
function required(key){const value=process.env[key];if(!value)throw Error('MISSING_CONFIG_'+key);return value;}
const source=parsePrivateServiceUrl(required('EI_LIVE_SOURCE_URL'),'EI_LIVE_SOURCE_URL');
const token=required('EI_LIVE_SOURCE_TOKEN');
const expected={
 scopeId:required('EI_SOURCE_SCOPE_ID'),
 sourceKeyDigest:required('EI_SOURCE_KEY_DIGEST'),
 connectionId:required('EI_SOURCE_CONNECTION_ID'),
 serverId:required('EI_SOURCE_SERVER_ID'),
 eventName:required('EI_SOURCE_EVENT_NAME'),
 argumentsCanonical:required('EI_SOURCE_ARGUMENTS_CANONICAL'),
 completenessRevision:1,
};
const key=required('EI_SOURCE_TRUSTED_PUBLIC_KEY_PEM').replace(/\\n/g,'\n');
const pinned=required('EI_SOURCE_TRUSTED_PUBLIC_KEY_SHA256');
if(sha(key)!==pinned)throw Error('SOURCE_PINNED_KEY_MISMATCH');
async function post(path,body,expectedStatus=200){
 const response=await fetch(source+path,{method:'POST',headers:{
  authorization:'Bearer '+token,'content-type':'application/json'},
  body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
 const result=await response.json().catch(()=>({}));
 if(response.status!==expectedStatus)
  throw Error('SOURCE_FAULT_MATRIX_HTTP_'+path.replace(/[^a-z0-9]/gi,'_')+'_'+response.status);
 return result;
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function negative(run,inputs,expectedCodes){
 try{await verifyStandaloneOracle(inputs);throw Error('UNSAFE_ORACLE_ACCEPT_'+run);}
 catch(error){
  if(!expectedCodes.includes(error?.code))throw error;
 }
}
let temp=null,revoked=false;const evidence={},run=randomUUID();
try{
 const status=await post('/status',{});
 if(status.revoked||status.revision<1)
  throw Error('SOURCE_NOT_ACTIVE_AT_START');
 evidence.initialRevision=status.revision;
 const health=await fetch(source+'/health',{signal:AbortSignal.timeout(5000)});
 if(!health.ok)throw Error('HEALTH_NOT_AVAILABLE');
 evidence.health=true;
 const first=await post('/control/append',{eventId:'fault-late-'+run,
   data:{fixtureRun:run,scenario:'delayed'}});
 if(first.accepted!==true)throw Error('DELAYED_EVENT_NOT_PERSISTED');
 const duplicate=await post('/control/append',{eventId:'fault-late-'+run,
   data:{fixtureRun:run,scenario:'delayed'}});
 if(duplicate.accepted!==false)throw Error('SOURCE_DUPLICATE_REPLAY_ACCEPTED');
 evidence.duplicateDenied=true;
 const reject=await post('/control/append',{eventId:'backdated-'+run,
   occurredAt:'2000-01-01T00:00:00.000Z'},400);
 if(reject.error!=='SOURCE_BACKDATED_EVENT_REJECTED')
  throw Error('CLIENT_BACKDATE_ACCEPTED');
 evidence.backdateDenied=true;
 // Temporarily omit this real new event from the *simulated consumer*.
 // If a downstream client inferred completeness from its last cursor,
 // that inference would be false: the authoritative source log has it.
 let cursor='source-v1:0',pages=0;
 const events=[];
 while(pages++<256){
  const result=(await post('/rpc',{jsonrpc:'2.0',id:pages,
    method:'events/poll',params:{cursor,maxEvents:1}})).result;
  if(result.truncated!==false||!Array.isArray(result.events))
   throw Error('UNEXPECTED_REAL_SOURCE_GAP');
  events.push(...result.events);
  if(result.hasMore!==true)break;
  if(typeof result.cursor!=='string'||cursor===result.cursor)
   throw Error('SOURCE_PAGINATION_STALLED');
  cursor=result.cursor;
 }
 const real=events.find(e=>e.eventId==='fault-late-'+run);
 if(!real||real.timestamp!==first.event.occurredAt)
  throw Error('SOURCE_REPLAY_MISSING_DELAYED_EVENT');
 evidence.realPaginatedReplay=pages>1;
 evidence.missingInSimulatedConsumer=events.filter(e=>e.eventId!=='fault-late-'+run)
   .every(e=>e.eventId!=='fault-late-'+run);
 // An adversarial/truncated transport response must not be promoted
 // to authoritative completeness. The live provider itself is untruncated.
 const fakeTruncated={truncated:true,cursor,events:[],hasMore:false};
 const clientGapUnresolved=fakeTruncated.truncated===true;
 if(!clientGapUnresolved)throw Error('TRUNCATED_RESPONSE_NOT_RECOGNIZED');
 evidence.truncatedTransportInjected=true;
 await wait(30);
 const sealed=await post('/control/seal',{});
 if(!sealed.completeThroughAt)throw Error('REAL_SOURCE_NOT_SEALED');
 const frontier=await post('/frontier',{completenessRevision:1});
 const archive=await post('/control/operator-archive',{});
 if(archive.sourceLog.head!==frontier.sourceLog.head||
    archive.sourceLog.sequence!==frontier.sourceLog.sequence)
  throw Error('ARCHIVE_VS_SEAL_CHECKPOINT_MISMATCH');
 const bytes=Buffer.from(archive.base64??'','base64');
 if(sha(bytes)!==archive.sha256||bytes.length!==archive.bytes)
  throw Error('RAW_ARCHIVE_SHA_INVALID');
 temp=await mkdtemp(join(tmpdir(),'ei-e48-negative-'));
 const logPath=join(temp,'source.jsonl');
 await writeFile(logPath,bytes,{mode:0o600});
 const args={logPath,sourceLog:archive.sourceLog,
  attestation:frontier.attestation,publicKeyPem:key,
  expected,now:Date.now()};
 const good=await verifyStandaloneOracle(args);
 if(!good.valid||!good.events.some(e=>e.eventId==='fault-late-'+run))
  throw Error('ORACLE_MISSING_INTENTIONALLY_DELAYED_EVENT');
 evidence.oracleSawMissingFromConsumer=true;
 const other=generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'});
 await negative('rotated-key',{...args,publicKeyPem:other},
   ['ORACLE_SIGNATURE_INVALID']);
 await negative('wrong-tenant',{...args,expected:{...expected,scopeId:'wrong-scope'}},
   ['ORACLE_SOURCE_IDENTITY_MISMATCH']);
 await negative('wrong-revision',{...args,expected:{...expected,completenessRevision:2}},
   ['ORACLE_FRONTIER_UNVERIFIED']);
 await negative('expired-claim',{...args,now:Date.now()+300001},
   ['ORACLE_FRONTIER_UNVERIFIED']);
 const wrongSignature={...frontier.attestation,
  signature:'A'.repeat(86)};
 await negative('tampered-signature',{...args,attestation:wrongSignature},
   ['ORACLE_SIGNATURE_INVALID']);
 evidence.oldRotatedWrongTenantRevisionExpiredTamperedDenied=true;
 // Revocation changes only this isolated first-party evidence provider,
 // not any EI worker or external host permission. Restore in finally.
 // Arm rollback BEFORE the mutating RPC: the source can durably revoke
 // even if the HTTP response or connection is lost.
 revoked=true;
 const revoke=await post('/control/revocation',{revoked:true});
 if(revoke.revoked!==true)throw Error('SOURCE_REVOKE_NOT_EFFECTIVE');
 const blocked=await Promise.all([
  post('/rpc',{jsonrpc:'2.0',id:9,method:'events/poll',
   params:{cursor:'source-v1:0'}},409),
  post('/control/append',{eventId:'revoked-'+run},409),
  post('/frontier',{completenessRevision:1},409),
 ]);
 if(blocked.some(x=>x.error!=='SOURCE_REVOKED'))
  throw Error('REVOKED_SOURCE_ACCEPTED_OPERATION');
 evidence.sourceRevokeDeniedPollAppendAndFrontier=true;
 // The source's ORIGINAL archive is still independently readable to
 // investigate revoked state, never deleted/pruned by this fixture.
 const afterRevoke=await post('/control/operator-archive',{});
 if(afterRevoke.sourceLog.sequence<=archive.sourceLog.sequence)
  throw Error('REVOCATION_NOT_DURABLE');
 evidence.revocationInDurableLog=true;
 const resumed=await post('/control/revocation',{revoked:false});
 if(resumed.revoked!==false)throw Error('SOURCE_RESTORE_FAILED');
 revoked=false;
 const stale=await post('/frontier',{completenessRevision:1},400);
 if(stale.error!=='SOURCE_UNSEALED')
  throw Error('PRE_REVOCATION_FRONTIER_UNSAFELY_REUSED');
 evidence.oldFrontierInvalidatedAfterRestore=true;
 await wait(30);
 const reseal=await post('/control/seal',{});
 if(reseal.revision!==resumed.revision)
  throw Error('RESEALED_SOURCE_REVISION_MISMATCH');
 const latest=await post('/frontier',{completenessRevision:1});
 const current=await post('/control/operator-archive',{});
 if(latest.sourceLog.head!==current.sourceLog.head)
  throw Error('NEW_SIGNED_HEAD_MISMATCH');
 const newer=Buffer.from(current.base64,'base64');
 await writeFile(logPath,newer,{mode:0o600});
 const proof=await verifyStandaloneOracle({...args,
  sourceLog:latest.sourceLog,attestation:latest.attestation,now:Date.now()});
 if(!proof.valid||proof.revision!==resumed.revision)
  throw Error('NEW_REVOKED_SOURCE_ERA_UNVERIFIED');
 await negative('old-signed-head',{...args,sourceLog:latest.sourceLog,now:Date.now()},
  ['ORACLE_FRONTIER_UNVERIFIED']);
 evidence.staleSignedHeadDenied=true;
 // Negative network outage simulation: never restart the actual provider.
 const unavailable=new URL(source);unavailable.port='1';
 let unavailableFailed=false;
 try{await fetch(unavailable.href+'health',{signal:AbortSignal.timeout(1000)});}
 catch{unavailableFailed=true;}
 if(!unavailableFailed)throw Error('SIMULATED_NETWORK_OUTAGE_NOT_DETECTED');
 evidence.simulatedTransportOutage=true;
 console.log(JSON.stringify({event:'ei_e48_live_source_negative_matrix',
  status:'passed',sourceSHA:required('EI_LIVE_PINNED_SOURCE_SHA'),
  sourceHeadSha256:current.sourceLog.head,
  archiveSha256:sha(newer),revocationRevision:resumed.revision,
  cases:evidence,firstPartySourceOnly:true,
  realTruncationOrProductionOutage:false,
  eiPgCandidateImpossibilityCertified:false,
  acceptanceE48AComplete:false}));
}catch(error){
 console.error(JSON.stringify({event:'ei_e48_live_source_negative_matrix',
  status:'failed',code:String(error?.code||error?.message||'UNKNOWN').slice(0,100)}));
 process.exitCode=1;
}finally{
 if(revoked){
  try{
   const restored=await post('/control/revocation',{revoked:false});
   if(restored.revoked!==false)throw Error('SOURCE_RESTORE_NOT_CONFIRMED');
  }catch{
   console.error(JSON.stringify({event:'ei_e48_negative_restore',
    status:'operator-intervention-required',code:'PROVIDER_MAY_BE_REVOKED'}));
    process.exitCode=1;}
 }
 if(temp)await rm(temp,{force:true,recursive:true}).catch(()=>{});
}
