import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
import {
  writePostgresAuditArchiveBundle,
  verifyPostgresAuditArchiveBundle,
  verifyPostgresAuditArchiveBundleFile,
  signPostgresAuditArchiveWitness,
  verifyPostgresAuditArchiveWitness,
} from '../scripts/lib/postgres-audit-archive-bundle.mjs';

const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const record=i=>({
  auditId:'audit-bundle-'+i,traceId:'trace-bundle',
  timestamp:'2026-10-20T13:20:00.000Z',
  kind:'trigger.created',entityType:'trigger',
  entityId:'tenant-a-trigger-'+i,details:{counter:i},
});

integration('PG16 audit bundle verifies whole externally pinned chain, survives later writes and catches database tamper',async()=>{
  const prefix='ei_auditbundle_'+randomBytes(5).toString('hex');
  const poolA=new Pool({connectionString:url,max:3});
  const poolB=new Pool({connectionString:url,max:3});
  const make=(pool,scope)=>new PostgresEventStore({
    pool,dispatchPoolIdentity:pool,tablePrefix:prefix,scopeId:scope,
  });
  const writer=make(poolA,'audit-A'),reader=make(poolB,'audit-A');
  const other=make(poolB,'audit-B');
  const dir=await mkdtemp(join(tmpdir(),'ei-pg-audit-bundle-'));
  try{
    await Promise.all([writer.init(),reader.init(),other.init()]);
    const empty=await writer.getAuditCheckpoint();
    assert.equal(empty.endSequence,-1);
    const emptyFile=join(dir,'empty.json');
    await writePostgresAuditArchiveBundle(writer,{
      trustedCheckpoint:empty,outputPath:emptyFile,pageSize:2,
    });
    assert.equal(await verifyPostgresAuditArchiveBundleFile(emptyFile,{
      trustedCheckpoint:empty,
    }),true);
    assert.equal((await readdir(dir)).length,1);
    for(let i=0;i<5;i++) {
      await (i%2?reader:writer).appendAudit(record(i));
    }
    await other.appendAudit(record('other-tenant'));
    const pinned=await writer.getAuditCheckpoint();
    assert.equal(pinned.endSequence,4);
    assert.equal((await other.getAuditCheckpoint()).endSequence,0);
    const path=join(dir,'verified-audit.json');
    const result=await writePostgresAuditArchiveBundle(reader,{
      trustedCheckpoint:pinned,outputPath:path,pageSize:2,
    });
    assert.equal(result.endSequence,4);
    assert.equal(result.headHash,pinned.headHash);
    assert.equal((await stat(path)).mode & 0o777,0o600);
    assert.equal(await verifyPostgresAuditArchiveBundleFile(path,{
      trustedCheckpoint:pinned,
    }),true);
    const rawBytes=await readFile(path);
    const keys=generateKeyPairSync('ed25519');
    const privateKeyPem=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
    const trustedPublicKeyPem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
    const signed=await signPostgresAuditArchiveWitness({
      archiveBytes:rawBytes,trustedCheckpoint:pinned,
      privateKeyPem,keyId:'operator-offhost-2026-01',
    });
    const verifySigned=(witness=signed,bytes=rawBytes,pub=trustedPublicKeyPem,
      expectedScopeId='audit-A')=>verifyPostgresAuditArchiveWitness({
        witness,archiveBytes:bytes,trustedPublicKeyPem:pub,
        expectedKeyId:'operator-offhost-2026-01',expectedScopeId,
      });
    assert.equal(await verifySigned(),true);
    assert.equal(await verifySigned(signed,rawBytes,trustedPublicKeyPem,'audit-B'),false);
    const swappedKey=generateKeyPairSync('ed25519');
    assert.equal(await verifySigned(signed,rawBytes,
      swappedKey.publicKey.export({type:'spki',format:'pem'}).toString()),false);
    assert.equal(await verifySigned({...signed,archiveBytes:signed.archiveBytes+1}),false);
    assert.equal(await verifySigned({...signed,
      checkpoint:{...pinned,endSequence:999}}),false);
    assert.equal(await verifySigned({...signed,
      archiveSha256:'0'.repeat(64)}),false);
    assert.equal(await verifySigned({...signed,
      signature:'A'.repeat(86)+'=='}),false);
    const changedBytes=Buffer.from(rawBytes);
    changedBytes[changedBytes.length-2] ^= 1;
    assert.equal(await verifySigned(signed,changedBytes),false);
    // Exact regression from Codex: JSON.parse sees the same Number for
    // two distinct decimal strings, but audit byte verification MUST fail.
    const losslessOriginal=rawBytes.toString('utf8');
    const roundedReplacement=losslessOriginal.replace(
      '"counter":2','"counter":2.0000000000000001');
    assert.notEqual(roundedReplacement,losslessOriginal);
    assert.deepEqual(JSON.parse(roundedReplacement),
      JSON.parse(losslessOriginal),'JS parse cannot detect this mutation');
    const roundedBytes=Buffer.from(roundedReplacement);
    assert.equal(await verifySigned(signed,roundedBytes),false);
    assert.equal(await verifyPostgresAuditArchiveBundle(
      JSON.parse(roundedReplacement),{
        trustedCheckpoint:pinned,rawArchiveBytes:roundedBytes,
      }),false,'reject rounded numeric token even when parsed proof is identical');

    await assert.rejects(()=>signPostgresAuditArchiveWitness({
      archiveBytes:rawBytes,trustedCheckpoint:{...pinned,headHash:'0'.repeat(64)},
      privateKeyPem,keyId:'operator-offhost-2026-01',
    }),/unverified or incomplete/);
    await assert.rejects(()=>signPostgresAuditArchiveWitness({
      archiveBytes:rawBytes,trustedCheckpoint:pinned,
      privateKeyPem:'not-a-key',keyId:'',
    }),TypeError);
    const original=await readFile(path,'utf8');
    const bundle=JSON.parse(original);
    // Inject extra serialized record fields without updating the audit
    // chain. A non-strict Zod parse alone would drop them and accept hash.
    const uncommitted=structuredClone(bundle);
    uncommitted.pages[0].records[0].spoofedOperator='attacker';
    const spoofedBytes=Buffer.from(JSON.stringify(uncommitted)+'\n');
    assert.equal(await verifyPostgresAuditArchiveBundle(uncommitted,{
      trustedCheckpoint:pinned,rawArchiveBytes:spoofedBytes,
    }),false,'unknown top-level audit bytes were never hash committed');
    await assert.rejects(()=>signPostgresAuditArchiveWitness({
      archiveBytes:spoofedBytes,trustedCheckpoint:pinned,
      privateKeyPem,keyId:'operator-offhost-2026-01',
    }),/unverified or incomplete/);
    const mutable=Buffer.from(rawBytes);
    const signing=signPostgresAuditArchiveWitness({
      archiveBytes:mutable,trustedCheckpoint:pinned,
      privateKeyPem,keyId:'operator-offhost-2026-01',
    });
    // In-flight caller mutation after first await must NOT change the
    // bytes that the signer proved and signed.
    queueMicrotask(()=>{mutable[mutable.length-2] ^= 1;});
    const copyWitness=await signing;
    assert.equal(await verifySigned(copyWitness,rawBytes),true,
      'witness must commit to immutable input snapshot, not caller-owned Buffer');
    assert.equal(await verifySigned(copyWitness,mutable),false);
    assert.equal(bundle.pages.length,3);
    assert.deepEqual(bundle.pages.map(p=>p.records.length),[2,2,1]);
    assert.equal(await verifyPostgresAuditArchiveBundle(bundle,{
      trustedCheckpoint:pinned,rawArchiveBytes:rawBytes,
    }),true);
    for(const modify of [
      b=>{b.pages[0].records[0].details.counter=999;},
      b=>{b.pages[1].records.reverse();},
      b=>{b.pages.pop();},
      b=>{b.pages[0].scopeId='audit-B';},
      b=>{b.pages[0].headHash='f'.repeat(64);},
      b=>{b.pages.push(structuredClone(b.pages.at(-1)));},
      b=>{b.checkpoint.scopeId='audit-B';},
    ]){
      const fake=structuredClone(bundle);
      modify(fake);
      assert.equal(await verifyPostgresAuditArchiveBundle(fake,{
        trustedCheckpoint:pinned,rawArchiveBytes:rawBytes,
      }),false);
    }
    await assert.rejects(()=>writePostgresAuditArchiveBundle(reader,{
      trustedCheckpoint:pinned,outputPath:path,
    }),/exists/);
    assert.equal(await readFile(path,'utf8'),original);
    const mutated=join(dir,'mutated.json');
    await writeFile(mutated,JSON.stringify({
      ...bundle,pages:bundle.pages.slice(0,1),
    }));
    assert.equal(await verifyPostgresAuditArchiveBundleFile(mutated,{
      trustedCheckpoint:pinned,
    }),false);
    const truncated=join(dir,'truncated.json');
    await writeFile(truncated,original.slice(0,-43));
    assert.equal(await verifyPostgresAuditArchiveBundleFile(truncated,{
      trustedCheckpoint:pinned,
    }),false);
    assert.equal(await verifyPostgresAuditArchiveBundleFile(path,{
      trustedCheckpoint:{...pinned,scopeId:'audit-B'},
    }),false);

    await writer.appendAudit(record(5));
    assert.equal((await writer.listAudit()).length,6);
    assert.equal(await verifyPostgresAuditArchiveBundleFile(path,{
      trustedCheckpoint:pinned,
    }),true,'frozen independent export unaffected by later append');
    assert.equal(await writer.verifyAudit(),true);
    assert.equal((await other.listAudit()).length,1);
    const archivedBefore=JSON.parse(original).pages[1].records[0];
    assert.equal(archivedBefore.details.counter,2);
    // Unknown top-level fields also must not be silently stripped by
    // audit parsing before checkpoint/signature verification.
    await poolA.query(
      'UPDATE "'+prefix+'_history" SET payload='+
      "jsonb_set(payload,'{spoofedOperator}','\"attacker\"'::jsonb) "+
      "WHERE scope_id=$1 AND kind='audit' AND payload->>'sequence'='2'",
      ['audit-A'],
    );
    await assert.rejects(()=>reader.getAuditCheckpoint(),
      e=>e.code==='EVENT_INTELLIGENCE_AUDIT_UNCOMMITTED_FIELDS');
    await assert.rejects(()=>reader.getAuditProofWindow({
      checkpoint:pinned,afterSequence:1,limit:2,
    }),e=>e.code==='EVENT_INTELLIGENCE_AUDIT_UNCOMMITTED_FIELDS');
    await poolA.query(
      'UPDATE "'+prefix+'_history" SET payload=payload-$1 '+
      "WHERE scope_id=$2 AND kind='audit' AND payload->>'sequence'='2'",
      ['spoofedOperator','audit-A'],
    );
    // A DB numeric lexeme can also be rewritten without changing its
    // parsed IEEE-754 Number. Snapshotting must fail closed BEFORE parse.
    await poolA.query(
      'UPDATE "'+prefix+'_history" SET payload='+
      "jsonb_set(payload,'{details,counter}','2.0000000000000001'::jsonb) "+
      "WHERE scope_id=$1 AND kind='audit' AND payload->>'sequence'='2'",
      ['audit-A'],
    );
    await assert.rejects(()=>reader.getAuditProofWindow({
      checkpoint:pinned,afterSequence:1,limit:2,
    }),e=>e.code==='EVENT_INTELLIGENCE_AUDIT_PRECISION_UNSAFE');
    await assert.rejects(()=>reader.getAuditCheckpoint(),
      e=>e.code==='EVENT_INTELLIGENCE_AUDIT_PRECISION_UNSAFE');
    await poolA.query(
      'UPDATE "'+prefix+'_history" SET payload='+
      "jsonb_set(payload,'{details,counter}','2'::jsonb) "+
      "WHERE scope_id=$1 AND kind='audit' AND payload->>'sequence'='2'",
      ['audit-A'],
    );
    // Alter the live stored history AFTER writing the durable archive.
    await poolA.query(
      'UPDATE "'+prefix+'_history" SET payload='+
      "jsonb_set(payload,'{details,counter}','999'::jsonb) "+
      "WHERE scope_id=$1 AND kind='audit' AND payload->>'sequence'='2'",
      ['audit-A'],
    );
    await assert.rejects(()=>reader.getAuditProofWindow({
      checkpoint:pinned,afterSequence:1,limit:2,
    }),e=>e.code==='EVENT_INTELLIGENCE_AUDIT_PROOF_CHAIN_INVALID');
    assert.equal(await verifyPostgresAuditArchiveBundleFile(path,{
      trustedCheckpoint:pinned,
    }),true,'archived chain independent from later corrupt database');
    assert.equal(await verifySigned(),true,
      'off-database signed archive must remain authentic after live database corruption');
  }finally{
    try{
      for(const suffix of ['metadata','leases','history','records','counters']){
        await poolA.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
      }
    }finally{
      await Promise.allSettled([poolA.end(),poolB.end()]);
      await rm(dir,{recursive:true,force:true});
    }
  }
});

test('audit archive refuses malformed checkpoint and unsafe file budgets',async()=>{
  const incomplete={scopeId:'A',firstHash:'f'.repeat(64),
    endSequence:1,headHash:'a'.repeat(64)};
  for(const opts of [
    {trustedCheckpoint:incomplete,pageSize:0,outputPath:'x'},
    {trustedCheckpoint:incomplete,pageSize:1001,outputPath:'x'},
    {trustedCheckpoint:incomplete,outputPath:''},
    {trustedCheckpoint:{...incomplete,endSequence:10001},outputPath:'x'},
    {trustedCheckpoint:{...incomplete,firstHash:'bad'},outputPath:'x'},
  ]) {
    await assert.rejects(()=>writePostgresAuditArchiveBundle({
      getAuditProofWindow:async()=>{throw Error('should never query store');},
    },opts),TypeError);
  }
});
