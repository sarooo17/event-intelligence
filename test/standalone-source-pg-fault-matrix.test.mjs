import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStandaloneSource} from '../scripts/validation/standalone-mcp-source.mjs';
import {verifyStandaloneOracle} from '../scripts/validation/standalone-mcp-source-oracle.mjs';
import {persistExternallyAttestedFrontier} from '../scripts/validation/mcp-source-frontier-attestation.mjs';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
import {TriggerInspector} from '../scripts/lib/trigger-inspector.mjs';

const postgresUrl=process.env.POSTGRES_URL;
const integration=postgresUrl?test:test.skip;
const hash=x=>createHash('sha256').update(x).digest('hex');
const stamp=ms=>new Date(ms).toISOString();

integration('real signed source append-only frontier selects candidate_impossible only when PG16 revision/tenant/gap agree',async()=>{
 const {Pool}=(await import('pg')).default;
 const suffix=randomBytes(5).toString('hex');
 const prefix='ei_source_fault_'+suffix,scope='source_fault_'+suffix;
 const otherScope='source_foreign_'+suffix;
 const pool=new Pool({connectionString:postgresUrl,max:4,
  statement_timeout:15000});
 const keys=generateKeyPairSync('ed25519');
 const pem=keys.privateKey.export({format:'pem',type:'pkcs8'});
 const publicKey=keys.publicKey.export({format:'pem',type:'spki'});
 const connectionId='real-source-connection',eventName='deploy.ok',serverId='git';
 const argumentsCanonical='{}';
 const sourceKeyDigest=hash(connectionId+'::'+eventName+'::'+argumentsCanonical);
 const source={connectionId,serverId,eventName,arguments:{}};
 const baseline=Date.now()-20000;
 let clock=baseline;
 const dir=await mkdtemp(join(tmpdir(),'ei-pg-source-'));
 const logPath=join(dir,'source.jsonl');
 let fixture=null;
 const a=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
  tablePrefix:prefix,scopeId:scope});
 const b=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
  tablePrefix:prefix,scopeId:otherScope});
 const definition={triggerId:'release',version:'1',clauses:[
  {id:'merged',serverId:'git',event:'pr.merged',where:[]},
  {id:'deployed',serverId:'git',event:'deploy.ok',where:[]}],
  pattern:{version:'2',root:{kind:'allOf',children:[
   {kind:'event',ref:'merged'},{kind:'event',ref:'deployed'}]}},
  withinMs:60000,target:{runtime:'host',kind:'task',id:'notify'}};
 const candidate={
  protocolVersion:'0.2.0',schemaVersion:'trigger.v0.2',
  matchId:'candidate-a',triggerId:'release',triggerVersion:'1',
  status:'partial',partitionKey:null,
  openedAt:stamp(clock-180000),updatedAt:stamp(clock-179000),
  expiresAt:stamp(clock-120000),
  sourceEvents:[{
   clauseId:'merged',traceId:'opaque-trace',sourceEventId:'merged-1',
   eventName:'pr.merged',serverId:'git',occurredAt:stamp(clock-180000),
   data:{watermarkAt:'2099-01-01T00:00:00.000Z',proofRef:'UNTRUSTED'}}],
  semanticDecision:null,firedWakeId:null,derivedEventIds:[],
  patternState:{version:'2',role:'buffer',
   maxObservedOccurredAt:stamp(clock-180000),semanticDecisions:[]},
 };
 const inspect=db=>new TriggerInspector({store:db,inspectionWindowLimit:3,
  evidenceRefLimit:3,matchHistoryLimit:3}).inspect({
   triggerId:'release',version:'1',matchId:'candidate-a'});
 const prepare=async(db,actor)=>{
  await db.init();await db.putTrigger(definition);
  await db.setTriggerState('release','1','active',null,{
   connectionIds:[connectionId],owner:{type:'user',principal_id:actor,tenant_id:actor}});
  await db.putEventSource({sourceId:'deployment',...source,enabled:true,delivery:['poll']});
  await db.appendTriggerMatch(candidate);
  await db.putMcpClientState({...source,sourceAvailability:'available'});
 };
 try{
  await prepare(a,scope);await prepare(b,otherScope);
  assert.equal((await inspect(a)).diagnosisV2.kind,'not_yet_satisfied');
  assert.equal((await inspect(b)).diagnosisV2.kind,'not_yet_satisfied');
  fixture=await createStandaloneSource({logPath,privateKeyPem:pem,
   scopeId:scope,sourceKeyDigest,connectionId,serverId,eventName,
   argumentsCanonical,now:()=>clock});
  // This source really has no deploy.ok events. Operator-assigned
  // event-time completeness is from a durable monotonic source seal,
  // NOT a self-asserted cursor or untrusted event.data.
  await fixture.seal();
  const signed=fixture.frontier({completenessRevision:1});
  const oracle=await verifyStandaloneOracle({logPath,
   sourceLog:signed.sourceLog,attestation:signed.attestation,
   publicKeyPem:publicKey,expected:{scopeId:scope,sourceKeyDigest,
    connectionId,serverId,eventName,argumentsCanonical,
    completenessRevision:1},now:clock+1000});
  assert.equal(oracle.eventCount,0);
  const args={store:a,source,expectedCompletenessRevision:1,
   trustedPublicKeyPem:publicKey,attestation:signed.attestation,
   sourceCompletenessContractIndependentlyVerified:true,now:()=>clock+1000};
  const badPublic=generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'});
  await assert.rejects(()=>persistExternallyAttestedFrontier({
   ...args,trustedPublicKeyPem:badPublic}),/signature|Unverified|attestation/i);
  await assert.rejects(()=>persistExternallyAttestedFrontier({
   ...args,sourceCompletenessContractIndependentlyVerified:false}),/not verified/i);
  assert.equal((await inspect(a)).diagnosisV2.kind,'not_yet_satisfied');
  await persistExternallyAttestedFrontier(args);
  const explained=await inspect(a);
  assert.equal(explained.diagnosisV2.kind,'candidate_impossible');
  assert.equal(explained.diagnosisV2.scope,'selected_match');
  assert.equal(explained.diagnosisV2.upstreamCompleteness,'unknown');
  assert.equal((await inspect(b)).diagnosisV2.kind,'not_yet_satisfied');
  await assert.rejects(()=>persistExternallyAttestedFrontier({
   ...args,store:b}),error=>
    error.code==='EVENT_INTELLIGENCE_UNVERIFIED_SOURCE_FRONTIER');
  // A missing/truncated poll after the signed seal increments the
  // source completeness revision and invalidates proof. Missing event
  // must not imply terminal global completeness.
  await a.putMcpClientState({...source,truncated:true});
  assert.equal((await inspect(a)).diagnosisV2.kind,'source_gap_unresolved');
  await assert.rejects(()=>persistExternallyAttestedFrontier(args),error=>
    error.code==='EVENT_INTELLIGENCE_STALE_SOURCE_FRONTIER');
  assert.equal((await inspect(b)).diagnosisV2.kind,'not_yet_satisfied');
  // The source itself will never sign a complete frontier while revoked
  // or reuse a prior seal after an availability epoch transition.
  await fixture.setRevoked(true);
  assert.throws(()=>fixture.poll(),e=>e.code==='SOURCE_REVOKED');
  assert.throws(()=>fixture.frontier({completenessRevision:2}),
   e=>e.code==='SOURCE_REVOKED');
  await fixture.setRevoked(false);
  assert.throws(()=>fixture.frontier({completenessRevision:2}),
   e=>e.code==='SOURCE_UNSEALED');
  clock+=1000;
  await fixture.seal();
  const after=fixture.frontier({completenessRevision:2});
  assert.notEqual(after.sourceLog.head,signed.sourceLog.head);
  // The independently pinned key may sign a new epoch, but the broken
  // PG state is still unusable until authoritative gap reconciliation.
  await assert.rejects(()=>persistExternallyAttestedFrontier({
   ...args,attestation:after.attestation,expectedCompletenessRevision:2,
   now:()=>clock+1000}),error=>
     error.code==='EVENT_INTELLIGENCE_STALE_SOURCE_FRONTIER');
  assert.equal((await inspect(a)).diagnosisV2.kind,'source_gap_unresolved');
 }finally{
  await fixture?.close().catch(()=>{});
  for(const suffix of ['metadata','leases','history','records','counters']){
   await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE')
     .catch(()=>{});
  }
  await pool.end();await rm(dir,{recursive:true,force:true});
 }
});
