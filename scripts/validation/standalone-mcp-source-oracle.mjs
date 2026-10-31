import {readFile} from 'node:fs/promises';
import {createHash,createPublicKey,verify as verifySignature} from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex');
const policy='monotonic-event-time-complete-through-v1';
const error=(code)=>Object.assign(new Error(code),{code});
const canonicalKeys=['contract','policy','scopeDigest','sourceKeyDigest',
  'argumentsDigest','connectionId','serverId','eventName',
  'completenessRevision','completeThroughAt','issuedAtMs','expiresAtMs'];
export async function verifyStandaloneOracle({logPath,sourceLog,
  attestation,publicKeyPem,expected,now=Date.now()}={}){
  if(typeof logPath!=='string'||!logPath||!expected||
     typeof publicKeyPem!=='string'||!Number.isSafeInteger(now))
    throw error('ORACLE_CONFIG_INVALID');
  // This verifier deliberately does NOT call the provider's parser,
  // state/nonce/clock logic or external frontier verifier. Separate
  // reader and cryptographic trust root; it still is a first-party oracle.
  const raw=await readFile(logPath,'utf8');
  if(raw.length>16*1024*1024||raw&&!raw.endsWith('\n'))
    throw error('ORACLE_LOG_INVALID');
  const rows=raw?raw.trimEnd().split('\n'):[];
  let hash='0'.repeat(64),lastTime=-1,seal=-1,activeSeal=-1,revision=1,revoked=false;
  const events=[],ids=new Set();
  for(let n=0;n<rows.length;n++){
    let r;try{r=JSON.parse(rows[n]);}catch{throw error('ORACLE_LOG_INVALID');}
    if(!r||r.seq!==n+1||r.prev!==hash||
       Object.keys(r).sort().join(',')!=='hash,payload,prev,seq'||
       r.hash!==sha(r.prev+'\n'+JSON.stringify(r.payload)))
      throw error('ORACLE_CHAIN_INVALID');
    hash=r.hash;
    const p=r.payload;
    if(n===0){
      const required={kind:'identity',scopeId:expected.scopeId,
        sourceKeyDigest:expected.sourceKeyDigest,
        connectionId:expected.connectionId,serverId:expected.serverId,
        eventName:expected.eventName,
        argumentsCanonical:expected.argumentsCanonical??'{}'};
      if(JSON.stringify(p)!==JSON.stringify(required))
        throw error('ORACLE_SOURCE_IDENTITY_MISMATCH');
      continue;
    }
    if(p?.kind==='event'){
      const ms=Date.parse(p.occurredAt);
      if(!p.eventId||ids.has(p.eventId)||!Number.isFinite(ms)||
         ms<=Math.max(lastTime,seal)||p.name!==expected.eventName)
        throw error('ORACLE_EVENT_INVALID');
      ids.add(p.eventId);lastTime=ms;
      events.push({eventId:p.eventId,name:p.name,timestamp:p.occurredAt,data:p.data});
    }else if(p?.kind==='seal'){
      const ms=Date.parse(p.completeThroughAt);
      if(!Number.isFinite(ms)||ms<lastTime||ms<=seal||p.revision!==revision)
        throw error('ORACLE_SEAL_INVALID');
      seal=ms;activeSeal=ms;
    }else if(p?.kind==='availability'){
      if(typeof p.revoked!=='boolean'||p.revoked===revoked||
         p.revision!==revision+1)throw error('ORACLE_REVISION_INVALID');
      revoked=p.revoked;revision++;activeSeal=-1;
    }else throw error('ORACLE_RECORD_KIND_INVALID');
  }
  if(!rows.length)throw error('ORACLE_SOURCE_IDENTITY_MISMATCH');
  if(!sourceLog||sourceLog.sequence!==rows.length||
     sourceLog.head!==hash||sourceLog.providerRevision!==revision)
    throw error('ORACLE_SOURCE_CHECKPOINT_MISMATCH');
  if(!attestation||typeof attestation.payload!=='string'||
     typeof attestation.signature!=='string'||
     Buffer.byteLength(attestation.payload)>2048)
    throw error('ORACLE_SIGNATURE_INVALID');
  let claim,key;
  try{
    claim=JSON.parse(attestation.payload);
    key=createPublicKey(publicKeyPem);
  }catch{throw error('ORACLE_SIGNATURE_INVALID');}
  if(key.asymmetricKeyType!=='ed25519'||
     JSON.stringify(claim)!==attestation.payload||
     Object.keys(claim).join(',')!==canonicalKeys.join(',')||
     claim.contract!=='ei.external-source-frontier-claim.v1'||
     claim.policy!==policy||claim.scopeDigest!==sha(expected.scopeId)||
     claim.argumentsDigest!==sha(expected.argumentsCanonical??'{}')||
     claim.sourceKeyDigest!==expected.sourceKeyDigest||
     claim.connectionId!==expected.connectionId||
     claim.serverId!==expected.serverId||
     claim.eventName!==expected.eventName||
     claim.completenessRevision!==expected.completenessRevision||
     Date.parse(claim.completeThroughAt)!==activeSeal||revoked||
     !Number.isSafeInteger(claim.issuedAtMs)||
     !Number.isSafeInteger(claim.expiresAtMs)||
     claim.issuedAtMs>now||claim.expiresAtMs<=now||
     claim.expiresAtMs-claim.issuedAtMs>300000||
     Date.parse(claim.completeThroughAt)>claim.issuedAtMs)
    throw error('ORACLE_FRONTIER_UNVERIFIED');
  const signature=Buffer.from(attestation.signature,'base64url');
  if(signature.length!==64||!verifySignature(null,
    Buffer.from(attestation.payload,'utf8'),key,signature))
    throw error('ORACLE_SIGNATURE_INVALID');
  return Object.freeze({
    schema:'ei.standalone-source-oracle.v1',
    valid:true,sourceSequence:rows.length,sourceHeadHash:hash,
    eventCount:events.length,revision,seal:claim.completeThroughAt,
    events:Object.freeze(events),providerIndependentlyOperated:false,
    thirdPartyCompletenessCertified:false,
  });
}
