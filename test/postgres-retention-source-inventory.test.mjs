import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import test from 'node:test';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';

const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const event=i=>({
  eventId:'source-inventory-'+i,
  name:'fixture.retention.changed',
  timestamp:'2026-10-23T12:00:00.000Z',
  data:{revision:i},
});
const state=(id,extras={})=>({
  connectionId:'conn-'+id,serverId:'provider-'+id,
  eventName:'fixture.retention.changed',
  arguments:{project:'sample-'+id},
  cursor:'opaque-sensitive-cursor-'+id,
  deliveryMode:'poll',truncated:false,...extras,
});
const make=(pool,prefix,scopeId)=>new PostgresEventStore({
  pool,dispatchPoolIdentity:pool,tablePrefix:prefix,scopeId,
});

integration('PG16 source retention inventory is scope-bound, fenced and never authorizes destructive pruning',async()=>{
  const prefix='ei_source_inventory_'+randomBytes(4).toString('hex');
  const poolA=new Pool({connectionString:url,max:3});
  const poolB=new Pool({connectionString:url,max:3});
  const a=make(poolA,prefix,'tenant-A');
  const peer=make(poolB,prefix,'tenant-A');
  const other=make(poolB,prefix,'tenant-B');
  try{
    await Promise.all([a.init(),peer.init(),other.init()]);
    const noSources=await a.inspectMcpSourceRetentionBarriers();
    assert.equal(noSources.sourceCount,0);
    assert.equal(noSources.physicalSourcePruneAuthorized,false);
    assert.ok(noSources.blockers.includes('no-registered-provider-state'));

    await a.putMcpClientState(state('A'));
    await a.appendMcpOccurrence('provider-A',event(1),'sub-A');
    await other.putMcpClientState(state('B'));
    await other.appendMcpOccurrence('provider-B',event(2),'sub-B');
    const ready=await peer.inspectMcpSourceRetentionBarriers();
    assert.equal(ready.sourceCount,1);
    assert.equal(ready.sourceTailSequence,1);
    assert.equal(ready.sources[0].completenessRevision,1);
    assert.equal(ready.sources[0].gapUnresolved,false);
    assert.match(ready.sources[0].identitySha256,/^[a-f0-9]{64}$/);
    assert.match(ready.sources[0].cursorSha256,/^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(ready).includes('opaque-sensitive-cursor'),
      'never leak raw provider opaque cursors in an operator report');
    assert.ok(ready.blockers.includes('opaque-provider-cursor-to-sequence-floor-unproven'));
    assert.equal(ready.physicalSourcePruneAuthorized,false);
    assert.equal(ready.productionReplayFloorEstablished,false);
    assert.deepEqual(await a.inspectMcpSourceRetentionBarriers(),ready,
      'unchanged source and revision produce stable digest');

    const otherReport=await other.inspectMcpSourceRetentionBarriers();
    assert.equal(otherReport.sourceCount,1);
    assert.equal(otherReport.sourceTailSequence,1);
    assert.notEqual(otherReport.snapshotSha256,ready.snapshotSha256);
    assert.notEqual(otherReport.sources[0].identitySha256,ready.sources[0].identitySha256);

    await peer.putMcpClientState(state('A',{cursor:'next-opaque-token',truncated:true}));
    const gapped=await a.inspectMcpSourceRetentionBarriers();
    assert.ok(gapped.blockers.includes('unreconciled-provider-delivery-gap'));
    assert.equal(gapped.sources[0].gapUnresolved,true);
    assert.equal(gapped.sources[0].completenessRevision,2);
    assert.notEqual(gapped.snapshotSha256,ready.snapshotSha256);
    await peer.putMcpClientState(state('A',{cursor:'next-opaque-token-2',truncated:false}));
    const sticky=await a.inspectMcpSourceRetentionBarriers();
    assert.equal(sticky.sources[0].gapUnresolved,true,
      'healthy page must not erase a historical gap');
    assert.ok(sticky.blockers.includes('unreconciled-provider-delivery-gap'));
    assert.equal(sticky.sourceCount,1);
    assert.equal((await other.inspectMcpSourceRetentionBarriers()).sourceCount,1);
    assert.equal((await a.listMcpOccurrencesAfter(0)).length,1,
      'inventory never deletes source/dedup history');

    await a.putMcpClientState(state('C',{cursor:null}));
    const missing=await peer.inspectMcpSourceRetentionBarriers();
    assert.equal(missing.sourceCount,2);
    assert.ok(missing.blockers.includes('missing-opaque-provider-cursor'));
    await assert.rejects(()=>a.inspectMcpSourceRetentionBarriers({maxSources:1}),
      e=>e?.code==='EVENT_INTELLIGENCE_MCP_RETENTION_SCAN_BUDGET_EXCEEDED');
    for(const options of [{maxSources:0},{maxSources:16385},{maxScanMs:50},
      {maxScanMs:30001},{maxSources:1.5}]){
      await assert.rejects(()=>a.inspectMcpSourceRetentionBarriers(options),
        e=>e?.code==='EVENT_INTELLIGENCE_MCP_RETENTION_POLICY_INVALID');
    }

    // Codex P2: stored row bytes MUST be bounded before JSONB reaches
    // Node, including historical rows written before the new byte policy.
    await assert.rejects(()=>a.putMcpClientState(
      state('oversize',{cursor:'💻'.repeat(5000)})),
      e=>e?.code==='EVENT_INTELLIGENCE_MCP_CLIENT_STATE_SIZE_LIMIT');
    await assert.rejects(()=>a.putMcpClientState(
      state('oversize-args',{arguments:{payload:'z'.repeat(9500)}})),
      e=>e?.code==='EVENT_INTELLIGENCE_MCP_CLIENT_STATE_SIZE_LIMIT');
    const rows=await poolA.query(
      'SELECT record_key,payload::text AS original FROM "'+prefix+
      '_records" WHERE scope_id=$1 AND kind=$2 ORDER BY record_key',
      ['tenant-A','mcp_client_state'],
    );
    const first=rows.rows[0];
    await poolA.query('UPDATE "'+prefix+'_records" SET record_key=$1'+
      ' WHERE scope_id=$2 AND kind=$3 AND record_key=$4',[
        first.record_key+'-forged','tenant-A','mcp_client_state',first.record_key,
      ]);
    await assert.rejects(()=>a.inspectMcpSourceRetentionBarriers(),
      e=>e?.code==='EVENT_INTELLIGENCE_MCP_RETENTION_STATE_INVALID',
      'a valid-looking payload under a forged durable key is not a valid inventory');
    await poolA.query('UPDATE "'+prefix+'_records" SET record_key=$1'+
      ' WHERE scope_id=$2 AND kind=$3 AND record_key=$4',[
        first.record_key,'tenant-A','mcp_client_state',first.record_key+'-forged',
      ]);
    await poolA.query('UPDATE "'+prefix+'_records" SET payload=jsonb_set('+
      "payload,'{cursor}',to_jsonb(repeat('y',70000)))"+
      ' WHERE scope_id=$1 AND kind=$2 AND record_key=$3',[
        'tenant-A','mcp_client_state',first.record_key,
      ]);
    await assert.rejects(()=>a.inspectMcpSourceRetentionBarriers(),
      e=>e?.code==='EVENT_INTELLIGENCE_MCP_RETENTION_SCAN_BUDGET_EXCEEDED',
      'oversized persisted JSONB must be rejected by SQL preflight before materializing');
    await poolA.query('UPDATE "'+prefix+'_records" SET payload=$1::jsonb'+
      ' WHERE scope_id=$2 AND kind=$3 AND record_key=$4',[
        first.original,'tenant-A','mcp_client_state',first.record_key,
      ]);
    assert.equal((await a.inspectMcpSourceRetentionBarriers()).sourceCount,2);

    // Codex P2: JSON.stringify is more compact than PostgreSQL's JSONB::text.
    // Pick a cursor whose compact JS state fits exactly within the limit,
    // while PostgreSQL's canonical rendering with spaces exceeds it.
    const persistedA=await a.getMcpClientState(
      'conn-A','fixture.retention.changed',{project:'sample-A'});
    const minimal={...persistedA,cursor:''};
    const free=16384-Buffer.byteLength(JSON.stringify(minimal),'utf8');
    assert.ok(free>100);
    const expanded={...minimal,cursor:'x'.repeat(free)};
    assert.ok(Buffer.byteLength(JSON.stringify(expanded),'utf8')<=16384);
    const rendered=await poolA.query(
      'SELECT octet_length($1::jsonb::text)::int AS n',
      [JSON.stringify(expanded)]);
    assert.ok(rendered.rows[0].n>16384,'PostgreSQL inserts separator bytes');
    await assert.rejects(()=>a.putMcpClientState(expanded),
      e=>e?.code==='EVENT_INTELLIGENCE_MCP_CLIENT_STATE_SIZE_LIMIT');
    assert.equal((await a.getMcpClientState(
      'conn-A','fixture.retention.changed',{project:'sample-A'}))
      .completenessRevision,persistedA.completenessRevision,
      'failed oversized update must roll back revision');

    // Codex P2: a restored gap field with an unexpected type cannot be
    // interpreted as false, even when the source key is canonical.
    for (const path of ['gapUnresolved','truncated']) {
      await poolA.query('UPDATE "'+prefix+'_records" SET payload=jsonb_set('+
        "payload,ARRAY[$1::text],to_jsonb('invalid'::text))"+
        ' WHERE scope_id=$2 AND kind=$3 AND record_key=$4',[
          path,'tenant-A','mcp_client_state',first.record_key,
        ]);
      await assert.rejects(()=>a.inspectMcpSourceRetentionBarriers(),
        e=>e?.code==='EVENT_INTELLIGENCE_MCP_RETENTION_STATE_INVALID');
      await poolA.query('UPDATE "'+prefix+'_records" SET payload=$1::jsonb'+
        ' WHERE scope_id=$2 AND kind=$3 AND record_key=$4',[
          first.original,'tenant-A','mcp_client_state',first.record_key,
        ]);
    }
    assert.equal((await a.inspectMcpSourceRetentionBarriers()).sourceCount,2);

    // Precision-dependent state revisions must never be rounded into a
    // plausible retention snapshot, even with zero pending delivery gaps.
    await poolA.query('UPDATE "'+prefix+'_records" SET payload=jsonb_set('+
      "payload,'{completenessRevision}','9007199254740993'::jsonb)"+
      ' WHERE scope_id=$1 AND kind=$2 AND record_key=$3',[
        'tenant-A','mcp_client_state',
        // Discover the exact persisted record_key under this tenant, not an
        // assumed provider cursor/argument serialization.
        (await poolA.query('SELECT record_key FROM "'+prefix+'_records"'+
          " WHERE scope_id=$1 AND kind='mcp_client_state' ORDER BY record_key LIMIT 1",
          ['tenant-A'])).rows[0].record_key,
      ]);
    await assert.rejects(()=>a.inspectMcpSourceRetentionBarriers(),
      e=>e?.code==='EVENT_INTELLIGENCE_MCP_RETENTION_STATE_INVALID');
    assert.equal((await other.inspectMcpSourceRetentionBarriers()).sourceCount,1,
      'corrupted tenant must not impact independently scoped other tenant');
  }finally{
    try{
      for(const suffix of ['metadata','leases','history','records','counters']){
        await poolA.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
      }
    }finally{await Promise.allSettled([poolA.end(),poolB.end()]);}
  }
});
