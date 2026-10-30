import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
import {
  SOURCE_FRONTIER_COMPLETENESS_POLICY,
  canonicalExternalSourceFrontierClaim,
  createExternalSourceFrontierVerifier,
  persistExternallyAttestedFrontier,
} from '../scripts/validation/mcp-source-frontier-attestation.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const keys=generateKeyPairSync('ed25519');
const publicPem=keys.publicKey.export({format:'pem',type:'spki'});
const nowMs=Date.UTC(2026,9,30,13,40,0);
function signed(fact,changes={}){
  const payload=canonicalExternalSourceFrontierClaim({
    contract:'ei.external-source-frontier-claim.v1',
    policy:SOURCE_FRONTIER_COMPLETENESS_POLICY,
    scopeDigest:sha(fact.scopeId),
    sourceKeyDigest:fact.sourceKeyDigest,
    argumentsDigest:sha(fact.argumentsCanonical),
    connectionId:fact.connectionId,serverId:fact.serverId,eventName:fact.eventName,
    completenessRevision:fact.completenessRevision,
    completeThroughAt:fact.completeThroughAt,
    issuedAtMs:nowMs,expiresAtMs:nowMs+120000,
    ...changes,
  });
  return {payload,signature:sign(null,Buffer.from(payload,'utf8'),
    keys.privateKey).toString('base64url')};
}
const sample={
  scopeId:'tenant-A',connectionId:'source-1',serverId:'source-upstream',
  eventName:'order.created',
  argumentsCanonical:'{"status":"paid"}',
  sourceKeyDigest:sha('scope-source-identity'),
  completenessRevision:1,
  completeThroughAt:'2026-10-30T13:39:00.000Z',
};
const fixture=()=>signed(sample);
test('trusted Ed25519 source attestation is scope/args/source/revision/TTL bound',async()=>{
 const attestation=fixture();
 const proof=createExternalSourceFrontierVerifier({
   trustedPublicKeyPem:publicPem,attestation,
   sourceCompletenessContractIndependentlyVerified:true,now:()=>nowMs+1000,
 });
 assert.equal(proof.proofRef.length,64);
 assert.equal(await proof.verifyProof({...sample,proofRef:proof.proofRef}),true);
 for(const patch of [
   {scopeId:'tenant-B'}, {sourceKeyDigest:sha('other')},
   {connectionId:'source-2'}, {serverId:'different'},
   {eventName:'order.deleted'}, {argumentsCanonical:'{}'},
   {completenessRevision:2},
   {completeThroughAt:'2026-10-30T13:38:59.000Z'},
   {proofRef:sha('different')},
 ]){
   assert.equal(await proof.verifyProof({...sample,proofRef:proof.proofRef,...patch}),false);
 }
 assert.equal(await createExternalSourceFrontierVerifier({
   trustedPublicKeyPem:publicPem,attestation,
   sourceCompletenessContractIndependentlyVerified:true,
   now:()=>nowMs+120000,
 }).verifyProof({...sample,proofRef:proof.proofRef}),false,
   'exact expiration cannot be used as a terminal source proof');
 assert.throws(()=>createExternalSourceFrontierVerifier({
   trustedPublicKeyPem:publicPem,attestation,
 }),/completeness contract not verified/);
});
test('spoofed MCP cursor/payload or modified signature cannot certify source completeness',()=>{
 const attestation=fixture();
 const edited={...attestation,payload:attestation.payload.replace(
   'order.created','order.deleted')};
 assert.throws(()=>createExternalSourceFrontierVerifier({
   trustedPublicKeyPem:publicPem,attestation:edited,
   sourceCompletenessContractIndependentlyVerified:true,
 }),/Unverified external source signature/);
 const fake={payload:attestation.payload,
   signature:Buffer.alloc(64).toString('base64url'),cursor:'cursor_999',
   truncated:false};
 assert.throws(()=>createExternalSourceFrontierVerifier({
   trustedPublicKeyPem:publicPem,attestation:fake,
   sourceCompletenessContractIndependentlyVerified:true,
 }),/Unverified external source signature/);
 assert.throws(()=>canonicalExternalSourceFrontierClaim({
   ...JSON.parse(attestation.payload),completeThroughAt:
     '2099-10-30T13:39:00.000Z',
 }),/Malformed/);
});
const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const prefix='ei_attest_'+randomBytes(5).toString('hex');
integration('PG16 proves authenticated external source frontier by tenant and revision, fails stale after new poll',async()=>{
 const pool=new Pool({connectionString:url,max:4});
 const db=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
   tablePrefix:prefix,scopeId:'attestation-tenant-A'});
 const source={connectionId:'real-connection',serverId:'real-mcp',
   eventName:'order.created',arguments:{status:'paid'}};
 try{
   await db.init();
   await db.putMcpClientState({...source,sourceAvailability:'available'});
   const state=await db.getMcpClientState(source.connectionId,source.eventName,source.arguments);
   let context=null;
   // First capture ONLY the candidate source identity; deliberately DENY
   // this unsigned proof, so it does not persist any trusted frontier.
   await assert.rejects(()=>db.recordVerifiedInspectionFrontier({
     ...source,expectedCompletenessRevision:state.completenessRevision,
     completeThroughAt:'2026-10-30T13:39:00.000Z',proofRef:'unsigned',
     verifyProof:async fact=>{context=fact;return false;},
   }),e=>e.code==='EVENT_INTELLIGENCE_UNVERIFIED_SOURCE_FRONTIER');
   assert(context);
   const attestation=signed(context);
   const persisted=await persistExternallyAttestedFrontier({
     store:db,source,expectedCompletenessRevision:state.completenessRevision,
     trustedPublicKeyPem:publicPem,attestation,
     sourceCompletenessContractIndependentlyVerified:true,now:()=>nowMs+1000,
   });
   assert.equal(persisted.contract,'ei.host-verified-source-frontier.v1');
   assert.equal(persisted.completeThroughAt,'2026-10-30T13:39:00.000Z');
   const fetched=await db.getVerifiedInspectionFrontier(
     source.connectionId,source.eventName,source.arguments);
   assert.equal(fetched?.proofDigest,persisted.proofDigest);
   await db.putMcpClientState({...source,sourceAvailability:'available'});
   assert.equal(await db.getVerifiedInspectionFrontier(
     source.connectionId,source.eventName,source.arguments),null);
   await assert.rejects(()=>persistExternallyAttestedFrontier({
     store:db,source,expectedCompletenessRevision:state.completenessRevision,
     trustedPublicKeyPem:publicPem,attestation,
     sourceCompletenessContractIndependentlyVerified:true,now:()=>nowMs+1000,
   }),e=>e.code==='EVENT_INTELLIGENCE_STALE_SOURCE_FRONTIER');
 }finally{
   for(const suffix of ['metadata','leases','history','records','counters']){
     await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
   }
   await pool.end();
 }
});
