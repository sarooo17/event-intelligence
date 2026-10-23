import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { writeMcpOccurrenceArchiveBundle } from
  '../scripts/lib/mcp-occurrence-archive-bundle.mjs';
import { restoreMcpOccurrenceArchiveToIsolatedPostgres } from
  '../scripts/lib/mcp-occurrence-archive-restore.mjs';

const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const CONSENT='RESTORE_VERIFIED_SOURCE_TO_ISOLATED_EMPTY_POSTGRES';
const fixture=i=>({
  eventId:'archive-restore-id-'+i,name:'fixture.restore.event',
  timestamp:'2026-10-21T16:00:00.000Z',
  data:{i,amount:100+i},
});
const mk=(pool,prefix,scope)=>new PostgresEventStore({
  pool,tablePrefix:prefix,scopeId:scope,dispatchPoolIdentity:pool,
});
const checkRejected=e=>e?.code==='EVENT_INTELLIGENCE_MCP_ARCHIVE_RESTORE_REFUSED';
const drop=async(pool,prefix)=>{
  for(const suffix of ['metadata','leases','history','records','counters']){
    await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
  }
};

integration('PG16 source archive restores complete raw JSONB, dedup and sequence only into an isolated empty prefix',async()=>{
  const suffix=randomBytes(4).toString('hex');
  const sourcePrefix='ei_original_'+suffix,targetPrefix='ei_restore_'+suffix;
  const sourcePool=new Pool({connectionString:url,max:4});
  const restorePool=new Pool({connectionString:url,max:4});
  const source=mk(sourcePool,sourcePrefix,'tenant-origin');
  const target=mk(restorePool,targetPrefix,'tenant-origin');
  const originalOther=mk(sourcePool,sourcePrefix,'other-tenant');
  const dir=await mkdtemp(join(tmpdir(),'ei-source-restore-'));
  try{
    await Promise.all([source.init(),target.init(),originalOther.init()]);
    for(let i=0;i<4;i++)await source.appendMcpOccurrence(
      'remote-provider',fixture(i),'opaque-sub');
    await originalOther.appendMcpOccurrence('remote-provider',
      fixture('other'),'opaque-sub');
    // Signed source archive uses real lossless PG JSONB::text. This number
    // CANNOT survive a JS Number JSON.parse/stringify roundtrip.
    for(const table of ['history','records']){
      await sourcePool.query(
        'UPDATE "'+sourcePrefix+'_'+table+'" SET payload='+ 
        "jsonb_set(payload,'{event,data,amount}',"+
        "'9007199254740993'::jsonb)"+
        " WHERE scope_id=$1 AND kind=$2 AND payload->>'sequence'='2'",
        ['tenant-origin',table==='history'?'mcp_occurrence':'mcp_occurrence_key'],
      );
    }
    const pinned=await source.getMcpOccurrenceArchiveCheckpoint();
    const out=join(dir,'source.json');
    await writeMcpOccurrenceArchiveBundle(source,{
      trustedCheckpoint:pinned,outputPath:out,pageSize:2,
    });
    const bundle=JSON.parse(await readFile(out,'utf8'));
    assert.equal(JSON.parse(bundle.pages[0].records[1]).event.data.amount,
      9007199254740992,'JS is lossy for 9007199254740993');
    assert.ok(bundle.pages[0].records[1].includes('9007199254740993'));
    await assert.rejects(()=>restoreMcpOccurrenceArchiveToIsolatedPostgres(
      target,{archive:bundle,trustedCheckpoint:pinned}),checkRejected);
    assert.equal(await target.latestMcpEventSequence(),0);
    const restored=await restoreMcpOccurrenceArchiveToIsolatedPostgres(target,{
      archive:bundle,trustedCheckpoint:pinned,
      confirmIsolatedRestore:CONSENT,
    });
    assert.equal(restored.restoredOccurrences,4);
    assert.equal(restored.restoredDedupKeys,4);
    assert.equal(restored.hostEffectsExecuted,0);
    assert.equal(restored.productionCutoverAuthorized,false);
    assert.equal(restored.targetPrefix,targetPrefix);
    const marker=await restorePool.query(
      'SELECT version,adopted_from FROM "'+targetPrefix+
      '_metadata" WHERE component=$1',['mcp-source-archive-restore']);
    assert.equal(marker.rows.length,1);
    assert.equal(marker.rows[0].version,1);
    assert.match(marker.rows[0].adopted_from,
      /^mcp-source-archive-sha256:[0-9a-f]{64}$/);
    assert.deepEqual(await target.getMcpOccurrenceArchiveCheckpoint(),pinned);
    // Restoration is lossless: the exact >2^53 JSONB amount survived.
    // But returning this as a JS Number would silently round it. Until
    // precision-aware source replay exists, the live read must fail closed,
    // while source archive proof and raw isolated rows remain available.
    await assert.rejects(()=>target.listMcpOccurrencesAfter(0),
      error=>error?.code==='EVENT_INTELLIGENCE_MCP_REPLAY_HISTORY_GAP');
    const raw=await restorePool.query(
      'SELECT payload::text AS json FROM "'+targetPrefix+
      '_history" WHERE scope_id=$1 AND kind=$2 ORDER BY history_id',
      ['tenant-origin','mcp_occurrence'],
    );
    assert.deepEqual(raw.rows.map(x=>x.json),bundle.pages.flatMap(x=>x.records));
    const exact=await restorePool.query(
      'SELECT payload #>> \'{event,data,amount}\' AS original FROM "'+
        targetPrefix+'_history" WHERE scope_id=$1 AND kind=$2'+
        " AND payload->>'sequence'='2'",
      ['tenant-origin','mcp_occurrence'],
    );
    assert.equal(exact.rows[0].original,'9007199254740993');
    const duplicate=await target.appendMcpOccurrence(
      'remote-provider',fixture(0),'opaque-sub');
    assert.equal(duplicate.accepted,false);
    assert.equal(duplicate.sequence,1);
    assert.equal(await target.latestMcpEventSequence(),4);
    assert.equal((await target.listAudit()).length,0);
    assert.equal((await originalOther.listMcpOccurrencesAfter(0)).length,1);
    await assert.rejects(()=>restoreMcpOccurrenceArchiveToIsolatedPostgres(
      target,{archive:bundle,trustedCheckpoint:pinned,
        confirmIsolatedRestore:CONSENT}),checkRejected);
    // Even if archive bytes are syntactically valid, one tampered page must
    // stop the restore BEFORE acquiring any PostgreSQL lock.
    const altered=structuredClone(bundle);
    altered.pages[0].records[0]=altered.pages[0].records[0].replace(
      'archive-restore-id-0','archive-restore-forged');
    await assert.rejects(()=>restoreMcpOccurrenceArchiveToIsolatedPostgres(
      target,{archive:altered,trustedCheckpoint:pinned,
        confirmIsolatedRestore:CONSENT}),checkRejected);
    assert.equal(await target.latestMcpEventSequence(),4);
  }finally{
    try{
      await drop(sourcePool,sourcePrefix);
      await drop(restorePool,targetPrefix);
    }finally{
      await Promise.allSettled([sourcePool.end(),restorePool.end()]);
      await rm(dir,{recursive:true,force:true});
    }
  }
});

integration('PG16 isolated archive restore rolls back every row on mid-stream failure, fences concurrent restores and rejects any preexisting tenant',async()=>{
  const suffix=randomBytes(4).toString('hex');
  const sourcePrefix='ei_original_'+suffix,targetPrefix='ei_restore_'+suffix;
  const srcPool=new Pool({connectionString:url,max:3});
  const poolA=new Pool({connectionString:url,max:3});
  const poolB=new Pool({connectionString:url,max:3});
  const source=mk(srcPool,sourcePrefix,'restore-scope');
  const targetA=mk(poolA,targetPrefix,'restore-scope');
  const targetB=mk(poolB,targetPrefix,'restore-scope');
  const other=mk(poolB,targetPrefix,'other-tenant');
  const dir=await mkdtemp(join(tmpdir(),'ei-restore-rollback-'));
  try{
    await Promise.all([source.init(),targetA.init(),targetB.init(),other.init()]);
    for(let i=0;i<4;i++){
      await source.appendMcpOccurrence('fixture-provider',fixture(i),'sub');
    }
    const trustedCheckpoint=await source.getMcpOccurrenceArchiveCheckpoint();
    const outputPath=join(dir,'source.json');
    await writeMcpOccurrenceArchiveBundle(source,{
      trustedCheckpoint,outputPath,pageSize:2,
    });
    const archive=JSON.parse(await readFile(outputPath,'utf8'));
    const args={archive,trustedCheckpoint,confirmIsolatedRestore:CONSENT};
    await poolA.query('ALTER TABLE "'+targetPrefix+'_history"'+
      " ADD CONSTRAINT injected_restore_failure CHECK ("+
      "kind <> 'mcp_occurrence' OR payload->>'sequence' <> '3')");
    await assert.rejects(()=>
      restoreMcpOccurrenceArchiveToIsolatedPostgres(targetA,args));
    for(const table of ['history','records','counters','leases']){
      const r=await poolB.query(
        'SELECT count(*)::int AS n FROM "'+targetPrefix+'_'+table+'"',
      );
      assert.equal(r.rows[0].n,0,'transaction rolled back '+table);
    }
    await poolA.query('ALTER TABLE "'+targetPrefix+
      '_history" DROP CONSTRAINT injected_restore_failure');
    const simultaneous=await Promise.allSettled([
      restoreMcpOccurrenceArchiveToIsolatedPostgres(targetA,args),
      restoreMcpOccurrenceArchiveToIsolatedPostgres(targetB,args),
    ]);
    assert.equal(simultaneous.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(simultaneous.filter(x=>x.status==='rejected'&&
      checkRejected(x.reason)).length,1);
    assert.equal((await targetA.listMcpOccurrencesAfter(0)).length,4);
    assert.deepEqual(await targetB.getMcpOccurrenceArchiveCheckpoint(),
      trustedCheckpoint);
    // Even an operator that later wipes every restored source/counter row
    // must not make this previously used schema appear fresh again.
    for(const table of ['history','records','counters']){
      await poolA.query('DELETE FROM "'+targetPrefix+'_'+table+'"');
    }
    assert.equal(await targetA.latestMcpEventSequence(),0);
    await assert.rejects(()=>
      restoreMcpOccurrenceArchiveToIsolatedPostgres(targetA,args),checkRejected,
      'persistent checkpoint provenance remains after data are cleared');
    const foreignPrefix='ei_restore_foreign_'+suffix;
    const foreign=mk(poolA,foreignPrefix,'restore-scope');
    const foreignTenant=mk(poolB,foreignPrefix,'other-tenant');
    await Promise.all([foreign.init(),foreignTenant.init()]);
    try {
      await foreignTenant.appendMcpOccurrence('provider',
        fixture('foreign'),'sub');
      await assert.rejects(()=>
        restoreMcpOccurrenceArchiveToIsolatedPostgres(foreign,args),checkRejected,
        'other tenant in dedicated prefix is forbidden');
      assert.equal(await foreign.latestMcpEventSequence(),0);
      assert.equal(await foreignTenant.latestMcpEventSequence(),1);
    } finally { await drop(poolA,foreignPrefix); }
  }finally{
    try{
      await drop(srcPool,sourcePrefix);
      await drop(poolA,targetPrefix);
    }finally{
      await Promise.allSettled([srcPool.end(),poolA.end(),poolB.end()]);
      await rm(dir,{recursive:true,force:true});
    }
  }
});

integration('PG16 empty trusted archive commits a durable one-time restore marker',async()=>{
  const suffix=randomBytes(4).toString('hex');
  const sourcePrefix='ei_src_empty_'+suffix;
  const targetPrefix='ei_restore_empty_'+suffix;
  const poolA=new Pool({connectionString:url,max:3});
  const poolB=new Pool({connectionString:url,max:3});
  const source=mk(poolA,sourcePrefix,'empty-archive');
  const targetA=mk(poolA,targetPrefix,'empty-archive');
  const targetB=mk(poolB,targetPrefix,'empty-archive');
  const dir=await mkdtemp(join(tmpdir(),'ei-empty-restore-'));
  try {
    await Promise.all([source.init(),targetA.init(),targetB.init()]);
    const trustedCheckpoint=await source.getMcpOccurrenceArchiveCheckpoint();
    assert.equal(trustedCheckpoint.endSequence,0);
    const outputPath=join(dir,'empty.json');
    await writeMcpOccurrenceArchiveBundle(source,{
      trustedCheckpoint,outputPath,
    });
    const archive=JSON.parse(await readFile(outputPath,'utf8'));
    assert.deepEqual(archive.pages,[]);
    const args={archive,trustedCheckpoint,confirmIsolatedRestore:CONSENT};
    const attempted=await Promise.allSettled([
      restoreMcpOccurrenceArchiveToIsolatedPostgres(targetA,args),
      restoreMcpOccurrenceArchiveToIsolatedPostgres(targetB,args),
    ]);
    assert.equal(attempted.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(attempted.filter(x=>x.status==='rejected'&&
      checkRejected(x.reason)).length,1);
    const first=attempted.find(x=>x.status==='fulfilled').value;
    assert.equal(first.restoredOccurrences,0);
    assert.equal(first.restoredDedupKeys,0);
    assert.deepEqual(await targetB.getMcpOccurrenceArchiveCheckpoint(),
      trustedCheckpoint);
    const marker=await poolB.query(
      'SELECT component,adopted_from FROM "'+targetPrefix+
      '_metadata" WHERE component=$1',['mcp-source-archive-restore']);
    assert.equal(marker.rows.length,1);
    assert.match(marker.rows[0].adopted_from,
      /^mcp-source-archive-sha256:[0-9a-f]{64}$/);
    for(const table of ['records','history','counters','leases']){
      const n=await poolB.query('SELECT count(*)::int AS n FROM "'+
        targetPrefix+'_'+table+'"');
      assert.equal(n.rows[0].n,0);
    }
    await assert.rejects(()=>
      restoreMcpOccurrenceArchiveToIsolatedPostgres(targetB,args),checkRejected,
      'zero-row restore must not appear unused to another process');
  } finally {
    try{
      await drop(poolA,sourcePrefix);
      await drop(poolA,targetPrefix);
    }finally{
      await Promise.allSettled([poolA.end(),poolB.end()]);
      await rm(dir,{recursive:true,force:true});
    }
  }
});
