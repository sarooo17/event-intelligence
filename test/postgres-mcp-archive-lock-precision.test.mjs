import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  PostgresEventStore,
  verifyMcpOccurrenceArchiveWindow,
} from '../scripts/lib/postgres-event-store.mjs';

const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integration = url ? test : test.skip;
const name = 'fixture.archive.precision';
const event = id => ({
  eventId: id, name, timestamp: '2026-10-19T12:00:00.000Z',
  data: { amount: 9007199254740992 },
});
const make = (pool, prefix, scopeId='scope-A') =>
  new PostgresEventStore({pool, dispatchPoolIdentity: pool,
    tablePrefix: prefix, scopeId});
async function cleanup(prefix, pool, others=[]) {
  try {
    for(const suffix of ['metadata','leases','history','records','counters']) {
      await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    }
  } finally {
    await Promise.allSettled([pool,...others].map(p=>p.end()));
  }
}
integration('PG checkpoint blocks on a real in-flight sequence+history append', {timeout:25000}, async()=>{
  const prefix='ei_arcbar_'+randomBytes(5).toString('hex');
  const poolA=new Pool({connectionString:url,max:3});
  const poolB=new Pool({connectionString:url,max:3});
  const reader=make(poolB,prefix);
  let releaseWriter;
  const resume=new Promise(resolve=>{releaseWriter=resolve;});
  let markCounterReached;
  const reached=new Promise(resolve=>{markCounterReached=resolve;});
  const proxy={
    query:(...args)=>poolA.query(...args),
    connect:async()=>{
      const client=await poolA.connect();
      return {
        query:async(sql,args)=>{
          const result=await client.query(sql,args);
          if(String(sql).includes('RETURNING value') &&
              args?.[1]==='mcp_occurrence') {
            // Counter increment has committed to this open transaction, but
            // source history is not appended yet: block until checkpoint
            // from the other pool actually contends on the counter row.
            markCounterReached();
            await resume;
          }
          return result;
        },
        release:(...args)=>client.release(...args),
      };
    },
  };
  const writer=make(proxy,prefix);
  try {
    await reader.init();
    const appended=writer.appendMcpOccurrence('source-provider',event('overlap'),'sub-A');
    await reached;
    let finished=false;
    const snapshot=reader.getMcpOccurrenceArchiveCheckpoint().then(cp=>{
      finished=true;
      return cp;
    });
    // The independent PG transaction waits for the sequence row held by
    // the unfinished writer, instead of pinning a sequence with no payload.
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(finished,false,'checkpoint must wait on active writer transaction');
    releaseWriter();
    const [written,cp]=await Promise.all([appended,snapshot]);
    assert.equal(written.sequence,1);
    assert.equal(cp.endSequence,1);
    const proof=await reader.getMcpOccurrenceArchiveWindow({checkpoint:cp,limit:2});
    assert.equal(proof.records.length,1);
    assert.equal(verifyMcpOccurrenceArchiveWindow(proof,{
      trustedCheckpoint:cp,trustedAfterSequence:0,
      trustedPreviousHash:cp.genesisHash,trustedLimit:2,
    }),true);
  } finally {
    releaseWriter();
    await cleanup(prefix,poolA,[poolB]);
  }
});

integration('PG JSONB number beyond JS safe precision cannot spoof a pinned source archive', async()=>{
  const prefix='ei_arcnum_'+randomBytes(5).toString('hex');
  const pool=new Pool({connectionString:url,max:3});
  const store=make(pool,prefix);
  try {
    await store.init();
    await store.appendMcpOccurrence('source-provider',event('large-number'),'sub-A');
    const pinned=await store.getMcpOccurrenceArchiveCheckpoint();
    const initial=await store.getMcpOccurrenceArchiveWindow({checkpoint:pinned,limit:2});
    assert.match(initial.records[0],/9007199254740992/);
    // Change only the JSONB numeric lexeme; parsing either into JS Number
    // would produce the *same* value. The archive signs raw JSONB::text.
    const beforeJson=JSON.parse(initial.records[0]);
    await pool.query(
      'UPDATE "'+prefix+'_history" SET payload=jsonb_set('+
      "payload,'{event,data,amount}','9007199254740993'::jsonb)" +
      " WHERE scope_id=$1 AND kind='mcp_occurrence'",
      ['scope-A'],
    );
    const raw=await pool.query(
      'SELECT payload::text AS raw FROM "'+prefix+'_history"' +
      " WHERE scope_id=$1 AND kind='mcp_occurrence'",
      ['scope-A'],
    );
    assert.equal(beforeJson.event.data.amount,JSON.parse(raw.rows[0].raw).event.data.amount,
      'native JS parse loses this single-digit tampering');
    await assert.rejects(()=>store.getMcpOccurrenceArchiveWindow({
      checkpoint:pinned,limit:2,
    }),e=>e?.code==='EVENT_INTELLIGENCE_MCP_ARCHIVE_INTEGRITY_INVALID');
    const changed=await store.getMcpOccurrenceArchiveCheckpoint();
    assert.notEqual(changed.headHash,pinned.headHash);
  } finally {
    await cleanup(prefix,pool);
  }
});
