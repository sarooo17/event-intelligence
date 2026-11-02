import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStandaloneSource} from '../scripts/validation/standalone-mcp-source.mjs';
import {verifyStandaloneOracle} from '../scripts/validation/standalone-mcp-source-oracle.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');

test('standalone source oracle verifies exact bounded raw bytes without reopening paths',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ei-source-oracle-bytes-'));
 const logPath=join(dir,'source.jsonl');
 const keys=generateKeyPairSync('ed25519');
 const privateKeyPem=keys.privateKey.export({format:'pem',type:'pkcs8'});
 const publicKeyPem=keys.publicKey.export({format:'pem',type:'spki'});
 const identity={scopeId:'tenant-1',sourceKeyDigest:sha('source-identity'),
  connectionId:'host-conn',serverId:'source-a',eventName:'event.changed',
  argumentsCanonical:'{}',completenessRevision:1};
 let clock=Date.parse('2026-10-30T14:00:00.000Z');
 try{
  const source=await createStandaloneSource({
   logPath,privateKeyPem,scopeId:identity.scopeId,
   sourceKeyDigest:identity.sourceKeyDigest,
   connectionId:identity.connectionId,serverId:identity.serverId,
   eventName:identity.eventName,
   argumentsCanonical:identity.argumentsCanonical,now:()=>clock
  });
  clock+=1000;
  const append=await source.append({eventId:'event-01',data:{slot:0}});
  assert.equal(append.accepted,true);
  clock+=1000;
  await source.seal();
  const frontier=source.frontier({completenessRevision:1});
  const bytes=await readFile(logPath);
  const args={sourceLog:frontier.sourceLog,attestation:frontier.attestation,
   publicKeyPem,expected:identity,now:clock+1000};
  const original=await verifyStandaloneOracle({...args,logPath});
  const buffered=await verifyStandaloneOracle({...args,logBytes:bytes});
  assert.deepEqual(buffered.events,original.events);
  assert.equal(buffered.sourceHeadHash,original.sourceHeadHash);
  assert.equal(buffered.eventCount,1);
  await assert.rejects(()=>verifyStandaloneOracle({...args,
   logBytes:Buffer.from(bytes.toString('utf8').replace('event-01','event-02'))}),
   /ORACLE_CHAIN_INVALID/);
  await assert.rejects(()=>verifyStandaloneOracle({...args,logPath,logBytes:bytes}),
   /ORACLE_CONFIG_INVALID/);
  await assert.rejects(()=>verifyStandaloneOracle({...args,logBytes:Buffer.alloc(17*1024*1024)}),
   /ORACLE_LOG_INVALID/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
