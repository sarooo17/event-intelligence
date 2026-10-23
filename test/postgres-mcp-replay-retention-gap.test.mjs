import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';

const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const event=id=>({
  eventId:id,name:'fixture.retention.event',
  timestamp:'2026-10-21T15:00:00.000Z',data:{id},
});
const make=(pool,prefix,scopeId)=>new PostgresEventStore({
  pool,dispatchPoolIdentity:pool,tablePrefix:prefix,scopeId,
});
const gap=e=>e?.code==='EVENT_INTELLIGENCE_MCP_REPLAY_HISTORY_GAP';
const invalid=e=>e?.code==='EVENT_INTELLIGENCE_MCP_REPLAY_CURSOR_INVALID';

integration('PG16 independent workers refuse missing replay history, missing dedup and tampered sequence, even after a valid high cursor',async()=>{
  const prefix='ei_replaygap_'+randomBytes(5).toString('hex');
  const poolA=new Pool({connectionString:url,max:4});
  const poolB=new Pool({connectionString:url,max:4});
  const a=make(poolA,prefix,'replay-A');
  const peer=make(poolB,prefix,'replay-A');
  const b=make(poolB,prefix,'replay-B');
  const missingKey=make(poolA,prefix,'replay-C');
  const forged=make(poolB,prefix,'replay-D');
  const history='"'+prefix+'_history"',records='"'+prefix+'_records"';
  try{
    await Promise.all([a.init(),peer.init(),b.init(),missingKey.init(),forged.init()]);
    await Promise.all([0,1,2,3].map(i=>(i%2?peer:a)
      .appendMcpOccurrence('shared-provider',event('a-'+i),'active-sub')));
    const actual=await peer.listMcpOccurrencesAfter(0);
    assert.deepEqual(actual.map(r=>r.sequence),[1,2,3,4]);
    assert.deepEqual((await a.listMcpOccurrencesAfter(2)).map(r=>r.sequence),[3,4]);
    assert.deepEqual(await peer.listMcpOccurrencesAfter(4),[]);
    assert.equal(await peer.latestMcpEventSequence(),4);
    for(const cursor of [-1,0.25,Number.NaN,Number.MAX_SAFE_INTEGER+1,5,'2']){
      await assert.rejects(()=>peer.listMcpOccurrencesAfter(cursor),invalid);
    }
    await b.appendMcpOccurrence('shared-provider',event('b-0'),'active-sub');
    await b.appendMcpOccurrence('shared-provider',event('b-1'),'active-sub');
    assert.deepEqual((await b.listMcpOccurrencesAfter(0)).map(r=>r.sequence),[1,2]);

    // A silent physical prefix/interval TTL would previously return a
    // shorter success-shaped replay. BOTH initial and advanced cursors
    // must instead fail, even when every requested successor still exists.
    await poolA.query('DELETE FROM '+history+
      " WHERE scope_id=$1 AND kind='mcp_occurrence'"+
      " AND payload->>'sequence'='2'",['replay-A']);
    await assert.rejects(()=>peer.listMcpOccurrencesAfter(0),gap);
    await assert.rejects(()=>a.listMcpOccurrencesAfter(3),gap);
    assert.deepEqual((await b.listMcpOccurrencesAfter(0)).map(r=>r.sequence),[1,2],
      'retention violation in tenant A cannot hide tenant B valid replay');

    for(const id of ['c-0','c-1'])await missingKey.appendMcpOccurrence(
      'shared-provider',event(id),'active-sub');
    await poolB.query('DELETE FROM '+records+
      " WHERE scope_id=$1 AND kind='mcp_occurrence_key'"+
      " AND payload->>'sequence'='1'",['replay-C']);
    await assert.rejects(()=>missingKey.listMcpOccurrencesAfter(1),gap,
      'source payload without durable dedup key must not authorize replay');
    for(const id of ['d-0','d-1'])await forged.appendMcpOccurrence(
      'shared-provider',event(id),'active-sub');
    await poolA.query('UPDATE '+history+
      " SET payload=jsonb_set(payload,'{sequence}','17'::jsonb)"+
      " WHERE scope_id=$1 AND kind='mcp_occurrence'"+
      " AND payload->>'sequence'='1'",['replay-D']);
    await assert.rejects(()=>forged.listMcpOccurrencesAfter(1),gap,
      'forged historical sequence must not be silently discarded');
    assert.equal((await b.getMcpOccurrenceArchiveCheckpoint()).endSequence,2);
    // A history row whose eventId/sequence still match the dedup row
    // but whose event data changed is ALSO an unaccounted source tamper.
    const payloadTamper=make(poolA,prefix,'replay-payload-tamper');
    await payloadTamper.init();
    await payloadTamper.appendMcpOccurrence(
      'shared-provider',event('payload-0'),'active-sub');
    await poolA.query('UPDATE '+history+
      " SET payload=jsonb_set(payload,'{event,data,id}',"+
      "to_jsonb($2::text)) WHERE scope_id=$1"+
      " AND kind='mcp_occurrence'",['replay-payload-tamper','spoofed']);
    await assert.rejects(()=>payloadTamper.listMcpOccurrencesAfter(0),gap);
    // P1 numeric collision: PostgreSQL retains distinct JSONB integers
    // while Node's JSON.parse rounds 9007199254740993 to 9007199254740992.
    // A source-vs-dedup equality check must compare the ORIGINAL JSONB
    // text, not two identically rounded JavaScript objects.
    const precise=make(poolA,prefix,'replay-precision');
    await precise.init();
    await precise.appendMcpOccurrence('shared-provider',{
      ...event('precise-0'),data:{amount:9007199254740992},
    },'active-sub');
    await poolA.query('UPDATE '+history+
      " SET payload=jsonb_set(payload,'{event,data,amount}',"+
      "'9007199254740993'::jsonb) WHERE scope_id=$1"+
      " AND kind='mcp_occurrence'",['replay-precision']);
    await assert.rejects(()=>precise.listMcpOccurrencesAfter(0),gap);
    // Stronger regression: corrupt BOTH authoritative history and durable
    // dedup to the same lossless PG JSONB numeric value. Comparing their
    // raw strings succeeds, but returning JSON.parse would silently round
    // 9007199254740993 to 9007199254740992. Replay must still fail closed.
    await poolA.query('UPDATE '+records+
      " SET payload=jsonb_set(payload,'{event,data,amount}',"+
      "'9007199254740993'::jsonb) WHERE scope_id=$1"+
      " AND kind='mcp_occurrence_key'",['replay-precision']);
    const exactHistorical=await poolA.query('SELECT payload::text AS raw FROM '+
      history+" WHERE scope_id=$1 AND kind='mcp_occurrence'",['replay-precision']);
    const exactDedup=await poolA.query('SELECT payload::text AS raw FROM '+
      records+" WHERE scope_id=$1 AND kind='mcp_occurrence_key'",['replay-precision']);
    assert.equal(exactHistorical.rows[0].raw,exactDedup.rows[0].raw,
      'raw dedup and history are identical, so equality cannot catch precision loss');
    assert.match(exactHistorical.rows[0].raw,/9007199254740993/);
    await assert.rejects(()=>precise.listMcpOccurrencesAfter(0),gap,
      'lossy Number decoding must never masquerade as valid replay');
    await assert.rejects(()=>precise.listMcpOccurrencesAfter(1),gap,
      'a current cursor must not bypass unsafe source history');
    // Reader does not block the provider writer: a single PG MVCC snapshot
    // sees all or none of concurrent transactional source+dedup inserts.
    // Repeated read snapshots may end at different valid head sequences,
    // but none may observe a half-committed source.
    const activeWriter=make(poolA,prefix,'replay-E');
    const activeReader=make(poolB,prefix,'replay-E');
    await Promise.all([activeWriter.init(),activeReader.init()]);
    const operations=[];
    for(let i=0;i<24;i++) {
      operations.push((i%2?activeReader:activeWriter).appendMcpOccurrence(
        'live-provider',event('e-'+i),'live-sub'));
      operations.push(activeReader.listMcpOccurrencesAfter(0).then(rows=>{
        assert.deepEqual(rows.map(r=>r.sequence),
          Array.from({length:rows.length},(_,k)=>k+1));
      }));
    }
    await Promise.all(operations);
    assert.deepEqual((await activeReader.listMcpOccurrencesAfter(0))
      .map(r=>r.sequence),Array.from({length:24},(_,k)=>k+1));
  }finally{
    try{
      for(const suffix of ['metadata','leases','history','records','counters']){
        await poolA.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
      }
    }finally{
      await Promise.allSettled([poolA.end(),poolB.end()]);
    }
  }
});
