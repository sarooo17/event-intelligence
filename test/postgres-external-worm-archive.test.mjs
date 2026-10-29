import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mcpArchiveGenesis } from '../scripts/lib/mcp-occurrence-archive.mjs';
import { signMcpOccurrenceArchiveWitness } from '../scripts/lib/mcp-occurrence-archive-bundle.mjs';
import { signPostgresAuditArchiveWitness } from '../scripts/lib/postgres-audit-archive-bundle.mjs';
import { publishSignedSourceAndAuditWorm, uploadComplianceLockedObject } from '../scripts/evidence/postgres-external-worm-archive.mjs';

const commands = {};
for (const name of ['PutObject','HeadObject','GetObject','GetBucketVersioning','GetObjectLockConfiguration']) {
  commands[name+'Command'] = class { constructor(input){this.input=input;this.op=name;} };
}
class FakeS3 {
  constructor({versioned=true,locked=true,remoteMode='COMPLIANCE',corrupt=false}={}) {
    Object.assign(this,{versioned,locked,remoteMode,corrupt});
    this.objects=new Map();
    this.calls=[];
  }
  async send(command) {
    const {op,input} = command;
    this.calls.push(op);
    if(op==='GetBucketVersioning')return {Status:this.versioned?'Enabled':'Suspended'};
    if(op==='GetObjectLockConfiguration')return {
      ObjectLockConfiguration:{ObjectLockEnabled:this.locked?'Enabled':'Disabled'}};
    if(op==='PutObject'){
      const versionId='version-'+(this.objects.size+1);
      this.objects.set(input.Key,{versionId,body:Buffer.from(input.Body),input});
      return {VersionId:versionId};
    }
    const o=this.objects.get(input.Key);
    if(!o || input.VersionId!==o.versionId)throw Error('missing version');
    if(op==='HeadObject')return {
      VersionId:o.versionId,ObjectLockMode:this.remoteMode,
      ObjectLockRetainUntilDate:o.input.ObjectLockRetainUntilDate,
      ContentLength:o.body.length,Metadata:o.input.Metadata,
    };
    if(op==='GetObject')return {Body:{transformToByteArray:async()=>this.corrupt
      ?Buffer.from('tampered') :Buffer.from(o.body)}};
    throw Error('unexpected mock command '+op);
  }
}
const retainUntil=()=>new Date(Date.now()+45*24*60*60*1000);
const upload=async (mock,extra={})=>uploadComplianceLockedObject({
  client:mock,commands,bucket:'offhost-worm-test',key:'ei-archive/test/blob',
  bytes:Buffer.from('known signed bytes\n'),retainUntil:retainUntil(),...extra,
});

test('off-host WORM uploader demands pinned version, COMPLIANCE lock and exact readback',async()=>{
  const good=new FakeS3();
  const receipt=await upload(good);
  assert.equal(receipt.objectLockMode,'COMPLIANCE');
  assert.equal(receipt.readBackVerified,true);
  assert.match(receipt.versionId,/^version-/);
  for (const options of [
    {remoteMode:'GOVERNANCE'}, {corrupt:true},
  ]) {
    await assert.rejects(upload(new FakeS3(options)),/EI WORM archive refused/);
  }
  const invalid=await assert.rejects(upload(good,{key:'../mutable'}),/EI WORM archive refused/);
  void invalid;
  await assert.rejects(upload(good,{retainUntil:new Date(Date.now()-1000)}),/EI WORM archive refused/);
  assert.ok(!good.calls.includes('DeleteObject'));
  const deadline=retainUntil();
  const original=deadline.toISOString();
  const pending=upload(new FakeS3(),{retainUntil:deadline});
  deadline.setUTCFullYear(2040); // caller mutates after first async S3 request
  assert.equal((await pending).retainUntil,original);
});

async function signedEmptyArchives() {
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const privateKeyPem=privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const trustedPublicKeyPem=publicKey.export({type:'spki',format:'pem'}).toString();
  const scopeId='isolated-worm-scope';
  const genesisHash=mcpArchiveGenesis(scopeId);
  const sourceCheckpoint={schema:'event-intelligence.mcp-occurrence-archive.v1',
    scopeId,endSequence:0,genesisHash,headHash:genesisHash};
  const auditCheckpoint={scopeId,endSequence:-1,firstHash:null,headHash:null};
  const sourceArchiveBytes=Buffer.from(JSON.stringify({
    schema:'event-intelligence.mcp-occurrence-bundle.v1',
    checkpoint:sourceCheckpoint,pageSize:250,maxBytes:67108864,pages:[],
  })+'\n');
  const auditArchiveBytes=Buffer.from(JSON.stringify({
    schema:'event-intelligence.postgres-audit-bundle.v1',
    checkpoint:auditCheckpoint,pageSize:250,maxBytes:67108864,pages:[],
  })+'\n');
  const sourceKeyId='operator-ed25519-01', auditKeyId='operator-ed25519-01';
  const sourceWitness=await signMcpOccurrenceArchiveWitness({
    archiveBytes:sourceArchiveBytes,trustedCheckpoint:sourceCheckpoint,
    privateKeyPem,keyId:sourceKeyId});
  const auditWitness=await signPostgresAuditArchiveWitness({
    archiveBytes:auditArchiveBytes,trustedCheckpoint:auditCheckpoint,
    privateKeyPem,keyId:auditKeyId});
  return {sourceArchiveBytes,auditArchiveBytes,sourceWitness,auditWitness,
    sourceCheckpoint,auditCheckpoint,trustedPublicKeyPem,
    sourceKeyId,auditKeyId,expectedScopeId:scopeId};
}

test('publisher requires independently pinned signatures and real versioned Object Lock bucket',async()=>{
  const fixture=await signedEmptyArchives();
  const good=new FakeS3();
  const result=await publishSignedSourceAndAuditWorm({
    ...fixture,client:good,commands,bucket:'external-locked-bucket',retainUntil:retainUntil(),
  });
  assert.equal(result.objects.length,4);
  assert.equal(good.objects.size,5);
  assert.equal(result.manifest.readBackVerified,true);
  assert.equal(result.physicalPruneAuthorized,false);
  assert.equal(result.productionRetentionCertified,false);
  for(const receipt of [...result.objects,result.manifest]){
    assert.equal(good.objects.get(receipt.key).input.ObjectLockMode,'COMPLIANCE');
    assert.equal(receipt.readBackVerified,true);
  }
  // Snapshot witness/checkpoint objects synchronously before awaits.
  const mutable={...fixture,
    sourceWitness:{...fixture.sourceWitness},
    sourceCheckpoint:{...fixture.sourceCheckpoint},
    auditWitness:{...fixture.auditWitness},
    auditCheckpoint:{...fixture.auditCheckpoint},
  };
  const snapshotS3=new FakeS3();
  const snap=publishSignedSourceAndAuditWorm({
    ...mutable,client:snapshotS3,commands,
    bucket:'external-locked-bucket',retainUntil:retainUntil(),
  });
  mutable.sourceWitness.signature='tampered-after-call';
  mutable.sourceCheckpoint.endSequence=998;
  mutable.auditCheckpoint.endSequence=998;
  const verified=await snap;
  assert.equal(verified.objects.length,4);
  assert.equal(snapshotS3.objects.size,5);

  const wrongScope=new FakeS3();
  await assert.rejects(publishSignedSourceAndAuditWorm({
    ...fixture,expectedScopeId:'other',client:wrongScope,commands,
    bucket:'external-locked-bucket',retainUntil:retainUntil(),
  }),/TRUST_ROOT_REQUIRED/);
  assert.equal(wrongScope.calls.length,0);

  const badWitness=new FakeS3();
  await assert.rejects(publishSignedSourceAndAuditWorm({
    ...fixture,sourceArchiveBytes:Buffer.from('altered'),
    client:badWitness,commands,bucket:'external-locked-bucket',retainUntil:retainUntil(),
  }),/PINNED_WITNESS_INVALID/);
  assert.equal(badWitness.calls.length,0);

  for(const options of [{versioned:false},{locked:false}]) {
    const target=new FakeS3(options);
    await assert.rejects(publishSignedSourceAndAuditWorm({
      ...fixture,client:target,commands,bucket:'external-locked-bucket',retainUntil:retainUntil(),
    }),/EI WORM archive refused/);
    assert.ok(!target.calls.includes('PutObject'));
  }
});
