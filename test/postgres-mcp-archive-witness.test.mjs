import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { mcpArchiveGenesis } from '../scripts/lib/mcp-occurrence-archive.mjs';
import {
  signMcpOccurrenceArchiveWitness,
  verifyMcpOccurrenceArchiveWitness,
} from '../scripts/lib/mcp-occurrence-archive-bundle.mjs';

const keys=()=>generateKeyPairSync('ed25519');
const pem=(key,type)=>key.export({
  type:type==='private'?'pkcs8':'spki',format:'pem',
}).toString();
const checkpoint=scopeId=>{
  const genesisHash=mcpArchiveGenesis(scopeId);
  return {schema:'event-intelligence.mcp-occurrence-archive.v1',
    scopeId,genesisHash,endSequence:0,headHash:genesisHash};
};
const bytesFor=cp=>Buffer.from(JSON.stringify({
  schema:'event-intelligence.mcp-occurrence-bundle.v1',
  checkpoint:cp,pageSize:1,maxBytes:1024,pages:[],
})+'\n');

test('independently signed source witness requires original bytes, trusted checkpoint and key',async()=>{
  const cp=checkpoint('tenant-A');
  const bytes=bytesFor(cp);
  const signing=keys(),foreign=keys();
  const keyId='offline-retention-signing-01';
  const privateKeyPem=pem(signing.privateKey,'private');
  const trustedPublicKeyPem=pem(signing.publicKey,'public');
  const sign=opts=>signMcpOccurrenceArchiveWitness({
    archiveBytes:bytes,trustedCheckpoint:cp,privateKeyPem,keyId,...opts,
  });
  const witness=await sign();
  const check=(witnessInput=witness,byteInput=bytes,extra={})=>
    verifyMcpOccurrenceArchiveWitness({
      witness:witnessInput,archiveBytes:byteInput,trustedCheckpoint:cp,
      trustedPublicKeyPem,expectedKeyId:keyId,expectedScopeId:'tenant-A',...extra,
    });

  assert.equal(await check(),true);
  assert.equal(await check(witness,bytes,{expectedScopeId:'tenant-B'}),false);
  assert.equal(await check(witness,bytes,{expectedKeyId:'unknown-key'}),false);
  assert.equal(await check(witness,bytes,{
    trustedPublicKeyPem:pem(foreign.publicKey,'public'),
  }),false);
  assert.equal(await check(witness,bytes,{
    trustedCheckpoint:checkpoint('tenant-B'),
  }),false);
  assert.equal(await check(witness,bytes,{
    trustedCheckpoint:{...cp,endSequence:1},
  }),false,'old valid signed prefix is not acceptable after the pinned floor advances');
  assert.equal(await check({...witness,keyId:'other'}),false);
  assert.equal(await check({...witness,archiveSha256:'f'.repeat(64)}),false);
  assert.equal(await check({...witness,archiveBytes:bytes.length+1}),false);
  assert.equal(await check({...witness,signature:'A'.repeat(86)+'=='}),false);
  assert.equal(await check({...witness,privilegedPruneApproved:true}),false,
    'unsigned extra fields must not be interpreted as signed policy');
  assert.equal(await check({...witness,checkpoint:{...cp,ttlSafe:true}}),false);
  const changed=Buffer.from(bytes);
  changed[changed.length-2]^=1;
  assert.equal(await check(witness,changed),false);
  assert.equal(await check(witness,Buffer.from(bytes.toString().trim())),false,
    'JSON-equivalent byte rewrites are not the signed artifact');
  assert.equal(await check(witness,Buffer.from(bytes.toString('utf8')+' ')),false);

  await assert.rejects(sign({trustedCheckpoint:checkpoint('tenant-B')}),/untrusted/);
  await assert.rejects(sign({privateKeyPem:pem(keys().publicKey,'public')}),Error);
  await assert.rejects(sign({keyId:'bad key with spaces'}),TypeError);
  await assert.rejects(sign({archiveBytes:JSON.parse(bytes.toString())}),TypeError);
});

test('signer refuses duplicate JSON keys, malformed UTF-8 and non-Ed25519 keys',async()=>{
  const cp=checkpoint('tenant-Z'),real=keys();
  const sign=archiveBytes=>signMcpOccurrenceArchiveWitness({
    archiveBytes,trustedCheckpoint:cp,
    privateKeyPem:pem(real.privateKey,'private'),keyId:'off-host',
  });
  const bytes=bytesFor(cp);
  const duplicate=Buffer.from(bytes.toString().replace(
    '"pageSize":1','"pageSize":999,"pageSize":1'));
  assert.deepEqual(JSON.parse(duplicate.toString()),JSON.parse(bytes.toString()),
    'JSON.parse silently discards duplicate members');
  await assert.rejects(sign(duplicate),/ambiguous/);
  const escapedDuplicate=Buffer.from(bytes.toString().replace(
    '"pageSize":1','"page\\u0053ize":999,"pageSize":1'));
  await assert.rejects(sign(escapedDuplicate),/ambiguous/);
  const malformed=Buffer.concat([bytes,Buffer.from([0xff])]);
  await assert.rejects(sign(malformed),/ambiguous/);
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
  await assert.rejects(()=>signMcpOccurrenceArchiveWitness({
    archiveBytes:bytes,trustedCheckpoint:cp,
    privateKeyPem:pem(rsa.privateKey,'private'),keyId:'off-host',
  }),/Ed25519/);
});
