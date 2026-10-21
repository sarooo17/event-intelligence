import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import {
  writeMcpOccurrenceArchiveBundle,
  verifyMcpOccurrenceArchiveBundleFile,
} from '../scripts/lib/mcp-occurrence-archive-bundle.mjs';

const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const event=n=>({
  eventId:'archived-source-event-'+n,name:'fixture.archive.changed',
  timestamp:'2026-10-19T12:00:00.000Z',data:{number:n},
});

integration('real PG archive is pinned and independently verifiable after later source writes',async()=>{
  const prefix='ei_bundle_'+randomBytes(5).toString('hex');
  const poolA=new Pool({connectionString:url,max:3});
  const poolB=new Pool({connectionString:url,max:3});
  const a=new PostgresEventStore({pool:poolA,dispatchPoolIdentity:poolA,
    tablePrefix:prefix,scopeId:'source-tenant'});
  const reader=new PostgresEventStore({pool:poolB,dispatchPoolIdentity:poolB,
    tablePrefix:prefix,scopeId:'source-tenant'});
  const other=new PostgresEventStore({pool:poolB,dispatchPoolIdentity:poolB,
    tablePrefix:prefix,scopeId:'other-tenant'});
  const dir=await mkdtemp(join(tmpdir(),'ei-pg-bundle-'));
  try{
    await Promise.all([a.init(),reader.init(),other.init()]);
    for(let i=0;i<4;i++){
      assert.equal((await a.appendMcpOccurrence('test-provider',event(i),'test-sub')).accepted,true);
    }
    const pinned=await reader.getMcpOccurrenceArchiveCheckpoint();
    const path=join(dir,'signed-later-by-operator.json');
    const result=await writeMcpOccurrenceArchiveBundle(reader,{
      trustedCheckpoint:pinned,outputPath:path,pageSize:2});
    assert.equal(result.endSequence,4);
    assert.equal(await verifyMcpOccurrenceArchiveBundleFile(path,{trustedCheckpoint:pinned}),true);
    const originalBytes=await readFile(path,'utf8');
    const persisted=JSON.parse(originalBytes);
    assert.equal(persisted.pages.length,2);
    assert.equal(persisted.pages[0].records.length,2);
    assert.equal(JSON.parse(persisted.pages[0].records[0]).event.eventId,
      'archived-source-event-0');
    assert.equal((await other.getMcpOccurrenceArchiveCheckpoint()).endSequence,0,
      'archive must be tenant scoped');

    // Source continues ingesting after externally pinned snapshot. The
    // locally finalized archive remains a complete immutable logical prefix.
    await reader.appendMcpOccurrence('test-provider',event(4),'test-sub');
    assert.equal((await a.getMcpOccurrenceArchiveCheckpoint()).endSequence,5);
    assert.equal(await verifyMcpOccurrenceArchiveBundleFile(path,{trustedCheckpoint:pinned}),true);
    const replay=await a.appendMcpOccurrence('test-provider',event(0),'test-sub');
    assert.equal(replay.accepted,false,'export must not remove dedup keys');
    assert.equal(replay.sequence,1);
    assert.equal((await a.listMcpOccurrencesAfter(0)).length,5);

    // Direct database tampering is rejected against the pinned archive
    // while the already-written standalone bundle remains externally valid.
    await poolA.query(
      'UPDATE "'+prefix+'_history" SET payload=jsonb_set('+
      "payload,'{event,data,number}','999'::jsonb)" +
      " WHERE scope_id=$1 AND kind='mcp_occurrence'"+
      " AND payload->>'sequence'='4'",
      ['source-tenant'],
    );
    const previous=persisted.pages[0].headHash;
    await assert.rejects(()=>reader.getMcpOccurrenceArchiveWindow({
      checkpoint:pinned,afterSequence:2,previousHash:previous,limit:2,
    }),e=>e?.code==='EVENT_INTELLIGENCE_MCP_ARCHIVE_INTEGRITY_INVALID');
    assert.equal(await verifyMcpOccurrenceArchiveBundleFile(path,{trustedCheckpoint:pinned}),true,
      'the independent file keeps its original full verified historical snapshot');
    assert.equal(await readFile(path,'utf8'),originalBytes);
    assert.equal(await a.verifyAudit(),true);
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
