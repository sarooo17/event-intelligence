import {createHash,createPublicKey,verify as verifySignature} from 'node:crypto';

// Optional host-owned external source adapter. This module cannot turn an
// ordinary MCP cursor into an event-time completeness claim. Providers MUST
// explicitly attest that NO eligible event with event-time <= T remains
// undispatched, including replay and backdated-event semantics.
const POLICY='monotonic-event-time-complete-through-v1';
const sha=x=>createHash('sha256').update(x).digest('hex');
const validId=x=>typeof x==='string'&&x.length>=1&&x.length<=240;
const time=x=>typeof x==='string'&&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&
  Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;
const integer=x=>Number.isSafeInteger(x)&&x>=1;
export const SOURCE_FRONTIER_COMPLETENESS_POLICY=POLICY;

// Fixed-order canonical signed message, no user-payload JSON serialization.
export function canonicalExternalSourceFrontierClaim(x={}){
  if(x.contract!=='ei.external-source-frontier-claim.v1'||
     x.policy!==POLICY||
     !/^[a-f0-9]{64}$/.test(x.scopeDigest??'')||
     !/^[a-f0-9]{64}$/.test(x.sourceKeyDigest??'')||
     !/^[a-f0-9]{64}$/.test(x.argumentsDigest??'')||
     !validId(x.connectionId)||!validId(x.serverId)||
     !validId(x.eventName)||!integer(x.completenessRevision)||
     !time(x.completeThroughAt)||!integer(x.issuedAtMs)||
     !integer(x.expiresAtMs)||x.expiresAtMs<=x.issuedAtMs||
     x.expiresAtMs-x.issuedAtMs>300000||
     Date.parse(x.completeThroughAt)>x.issuedAtMs)
    throw new TypeError('Malformed bounded source frontier attestation');
  return JSON.stringify({
    contract:'ei.external-source-frontier-claim.v1',policy:POLICY,
    scopeDigest:x.scopeDigest,sourceKeyDigest:x.sourceKeyDigest,
    argumentsDigest:x.argumentsDigest,
    connectionId:x.connectionId,serverId:x.serverId,eventName:x.eventName,
    completenessRevision:x.completenessRevision,
    completeThroughAt:x.completeThroughAt,
    issuedAtMs:x.issuedAtMs,expiresAtMs:x.expiresAtMs,
  });
}

// Creates an Ed25519 *verifier only*, never a source signer. The public key
// is trusted by explicit host configuration, not fetched from event.data.
export function createExternalSourceFrontierVerifier({
  trustedPublicKeyPem,attestation,
  sourceCompletenessContractIndependentlyVerified=false,
  now=()=>Date.now(),
}={}){
  if(sourceCompletenessContractIndependentlyVerified!==true)
    throw new TypeError('External provider event-time completeness contract not verified');
  if(typeof trustedPublicKeyPem!=='string'||
     !attestation||typeof attestation.payload!=='string'||
     Buffer.byteLength(attestation.payload)>2048||
     typeof attestation.signature!=='string'||
     !/^[a-zA-Z0-9_-]{85,88}$/.test(attestation.signature)||
     typeof now!=='function')
    throw new TypeError('Invalid signed external source attestation');
  let publicKey,claim,canonical;
  try{
    publicKey=createPublicKey(trustedPublicKeyPem);
    if(publicKey.asymmetricKeyType!=='ed25519')
      throw new Error('Unexpected signature algorithm');
    claim=JSON.parse(attestation.payload);
    canonical=canonicalExternalSourceFrontierClaim(claim);
    if(canonical!==attestation.payload)
      throw new Error('Attestation payload must be canonical');
  }catch{
    throw new TypeError('External source attestation invalid');
  }
  const signatureBytes=Buffer.from(attestation.signature,'base64url');
  if(signatureBytes.length!==64)
    throw new TypeError('Ed25519 signature must be 64 bytes');
  const payloadBytes=Buffer.from(canonical,'utf8');
  if(!verifySignature(null,payloadBytes,publicKey,signatureBytes))
    throw new TypeError('Unverified external source signature');
  const proofRef=sha(canonical+'\n'+attestation.signature);
  return Object.freeze({
    proofRef,completeThroughAt:claim.completeThroughAt,
    async verifyProof(fact){
      const current=now();
      return Number.isSafeInteger(current)&&
        claim.issuedAtMs<=current&&current<claim.expiresAtMs&&
        current-claim.issuedAtMs<=300000 &&
        fact?.proofRef===proofRef &&
        sha(fact.scopeId??'')===claim.scopeDigest &&
        fact.sourceKeyDigest===claim.sourceKeyDigest &&
        sha(fact.argumentsCanonical??'')===claim.argumentsDigest &&
        fact.connectionId===claim.connectionId &&
        fact.serverId===claim.serverId &&
        fact.eventName===claim.eventName &&
        fact.completenessRevision===claim.completenessRevision &&
        fact.completeThroughAt===claim.completeThroughAt;
    },
  });
}
export async function persistExternallyAttestedFrontier({
  store,trustedPublicKeyPem,attestation,source,
  expectedCompletenessRevision,
  sourceCompletenessContractIndependentlyVerified=false,
  now,
}={}){
  if(!store||typeof store.recordVerifiedInspectionFrontier!=='function'||
     !source||!integer(expectedCompletenessRevision))
    throw new TypeError('Explicit trusted host/PG source adapter required');
  const proof=createExternalSourceFrontierVerifier({
    trustedPublicKeyPem,attestation,
    sourceCompletenessContractIndependentlyVerified,
    ...(now?{now}:{}),
  });
  return store.recordVerifiedInspectionFrontier({
    ...source,expectedCompletenessRevision,
    completeThroughAt:proof.completeThroughAt,
    proofRef:proof.proofRef,
    verifyProof:proof.verifyProof,
  });
}
