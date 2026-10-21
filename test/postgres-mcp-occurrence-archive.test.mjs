import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  PostgresEventStore, verifyMcpOccurrenceArchiveWindow,
} from '../scripts/lib/postgres-event-store.mjs';

const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integration = url ? test : test.skip;
const sample = i => ({
  eventId: 'retained-occurrence-' + i,
  name: 'fixture.archive.changed',
  timestamp: '2026-10-19T12:00:00.000Z',
  data: { sequence: i, nested: { b: 'second', a: 'first' } },
});

integration('PG source occurrence archive pages resist tampering and preserve cursor, audit and dedup', async () => {
  const prefix = 'ei_mcp_arch_' + randomBytes(5).toString('hex');
  const poolA = new Pool({ connectionString: url, max: 3 });
  const poolB = new Pool({ connectionString: url, max: 3 });
  const a = new PostgresEventStore({
    pool: poolA, dispatchPoolIdentity: poolA, tablePrefix: prefix,
    scopeId: 'archive-tenant-A',
  });
  const reader = new PostgresEventStore({
    pool: poolB, dispatchPoolIdentity: poolB, tablePrefix: prefix,
    scopeId: 'archive-tenant-A',
  });
  const other = new PostgresEventStore({
    pool: poolB, dispatchPoolIdentity: poolB, tablePrefix: prefix,
    scopeId: 'archive-tenant-B',
  });
  try {
    await Promise.all([a.init(), reader.init(), other.init()]);
    const emptyCp = await a.getMcpOccurrenceArchiveCheckpoint();
    const emptyProof = await reader.getMcpOccurrenceArchiveWindow({
      checkpoint: emptyCp, limit: 2,
    });
    assert.equal(emptyCp.endSequence, 0);
    assert.equal(emptyCp.genesisHash, emptyCp.headHash);
    assert.deepEqual(emptyProof.records, []);
    assert.equal(verifyMcpOccurrenceArchiveWindow(emptyProof, {
      trustedCheckpoint: emptyCp, trustedAfterSequence: 0,
      trustedPreviousHash: emptyCp.genesisHash, trustedLimit: 2,
    }), true);

    for (let i = 0; i < 5; i++) {
      const written = await (i % 2 ? reader : a).appendMcpOccurrence(
        'fixture-server', sample(i), 'sub-A');
      assert.equal(written.accepted, true);
      assert.equal(written.sequence, i + 1);
    }
    const externalCursor = {
      connectionId: 'fixture-connection', serverId: 'fixture-server',
      eventName: 'fixture.archive.changed', arguments: {},
      cursor: 'opaque-source-cursor-5', truncated: false,
    };
    await a.putMcpClientState(externalCursor);
    await a.appendAudit({
      auditId: 'archive-audit', traceId: 'archive-trace',
      timestamp: '2026-10-19T12:00:00.000Z',
      kind: 'trigger.created', entityType: 'trigger',
      entityId: 'archive-trigger', details: { observed: 5 },
    });
    const cp = await reader.getMcpOccurrenceArchiveCheckpoint();
    assert.equal(cp.endSequence, 5);
    const page1 = await a.getMcpOccurrenceArchiveWindow({
      checkpoint: cp, limit: 2,
    });
    assert.deepEqual(page1.records.map(r => r.sequence), [1, 2]);
    assert.equal(page1.hasMore, true);
    const verify = (page, after, hash, limit=2, checkpoint=cp) =>
      verifyMcpOccurrenceArchiveWindow(page, {
        trustedCheckpoint: checkpoint, trustedAfterSequence: after,
        trustedPreviousHash: hash, trustedLimit: limit,
      });
    assert.equal(verify(page1, 0, cp.genesisHash), true);
    const page2 = await reader.getMcpOccurrenceArchiveWindow({
      checkpoint: cp, afterSequence: page1.endSequence,
      previousHash: page1.headHash, limit: 2,
    });
    assert.deepEqual(page2.records.map(r => r.sequence), [3, 4]);
    assert.equal(verify(page2, 2, page1.headHash), true);
    const page3 = await a.getMcpOccurrenceArchiveWindow({
      checkpoint: cp, afterSequence: page2.endSequence,
      previousHash: page2.headHash, limit: 2,
    });
    assert.deepEqual(page3.records.map(r => r.sequence), [5]);
    assert.equal(page3.hasMore, false);
    assert.equal(page3.headHash, cp.headHash);
    assert.equal(verify(page3, 4, page2.headHash), true);
    const exhausted = await reader.getMcpOccurrenceArchiveWindow({
      checkpoint: cp, afterSequence: 5, previousHash: cp.headHash,
      limit: 2,
    });
    assert.deepEqual(exhausted.records, []);
    assert.equal(verify(exhausted, 5, cp.headHash), true);

    // Later inserts do not modify the already pinned five-record snapshot.
    await a.appendMcpOccurrence('fixture-server', sample(5), 'sub-A');
    assert.equal((await a.getMcpOccurrenceArchiveCheckpoint()).endSequence, 6);
    const frozen = await a.getMcpOccurrenceArchiveWindow({
      checkpoint: cp, afterSequence: 4, previousHash: page2.headHash,
      limit: 2,
    });
    assert.equal(verify(frozen, 4, page2.headHash), true);
    assert.equal((await other.getMcpOccurrenceArchiveCheckpoint()).endSequence, 0);
    const reused = await reader.appendMcpOccurrence('fixture-server', sample(0), 'sub-A');
    assert.equal(reused.accepted, false,
      'archiving must never drop existing source deduplication');
    assert.equal(reused.sequence, 1);
    assert.equal((await reader.getMcpClientState(
      'fixture-connection', 'fixture.archive.changed',
    )).cursor, 'opaque-source-cursor-5');
    assert.equal(await reader.verifyAudit(), true);
    assert.equal((await reader.listAudit()).length, 1);
    assert.equal((await a.listMcpOccurrencesAfter(0)).length, 6);

    // Independent verification uses a *previously pinned* external hash,
    // never a predecessor supplied ad hoc by the untrusted proof itself.
    const changed = structuredClone(page2);
    changed.records[0].event.data.sequence = 999;
    assert.equal(verify(changed, 2, page1.headHash), false,
      'payload changes invalidate the archived page hash');
    const dropped = structuredClone(page2);
    dropped.records.shift();
    assert.equal(verify(dropped, 2, page1.headHash), false);
    const reordered = structuredClone(page2);
    reordered.records.reverse();
    assert.equal(verify(reordered, 2, page1.headHash), false);
    assert.equal(verify(page2, 2, '0'.repeat(64)), false);
    assert.equal(verify(page2, 2, page1.headHash, 2,
      await other.getMcpOccurrenceArchiveCheckpoint()), false);
    assert.equal(verify(page3, 4, page2.headHash, 2,
      { ...cp, headHash: 'f'.repeat(64) }), false);
    assert.equal(verifyMcpOccurrenceArchiveWindow(page2), false);

    for (const invalid of [
      {maxOccurrences:0}, {maxOccurrences:10001}, {maxOccurrences:1},
      {maxScanMs:99}, {maxScanMs:30001},
    ]) {
      await assert.rejects(() => a.getMcpOccurrenceArchiveCheckpoint(invalid),
        e => ['EVENT_INTELLIGENCE_MCP_ARCHIVE_POLICY_INVALID',
          'EVENT_INTELLIGENCE_MCP_ARCHIVE_SCAN_BUDGET_EXCEEDED'].includes(e.code));
    }
    for (const invalid of [
      {limit:0}, {limit:1001}, {afterSequence:-1},
      {afterSequence:6}, {maxScanMs:90},
      {afterSequence:3}, {afterSequence:2,previousHash:'wrong'},
    ]) {
      await assert.rejects(() => a.getMcpOccurrenceArchiveWindow({
        checkpoint: cp, ...invalid,
      }), e => e.code === 'EVENT_INTELLIGENCE_MCP_ARCHIVE_POLICY_INVALID');
    }

    // The terminal checksum is anchored to the operator's frozen checkpoint.
    // Tampering with retained source history cannot generate a passing tail.
    await poolA.query(
      'UPDATE "' + prefix + '_history" SET payload=' +
      "jsonb_set(payload,'{event,data,sequence}','999'::jsonb)" +
      " WHERE scope_id=$1 AND kind='mcp_occurrence'" +
      " AND payload->>'sequence'='5'",
      ['archive-tenant-A'],
    );
    await assert.rejects(() => reader.getMcpOccurrenceArchiveWindow({
      checkpoint: cp, afterSequence: 4,
      previousHash: page2.headHash, limit: 2,
    }), e => e.code === 'EVENT_INTELLIGENCE_MCP_ARCHIVE_INTEGRITY_INVALID');
    await assert.rejects(() => reader.getMcpOccurrenceArchiveCheckpoint(),
      e => e.code === 'EVENT_INTELLIGENCE_MCP_ARCHIVE_INTEGRITY_INVALID' ||
        e.code === 'EVENT_INTELLIGENCE_MCP_ARCHIVE_SCAN_BUDGET_EXCEEDED');
    assert.equal(await a.verifyAudit(), true,
      'source corruption cannot silently mutate independent audit history');
  } finally {
    try {
      for (const suffix of ['metadata','leases','history','records','counters']) {
        await poolA.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
      }
    } finally {
      await Promise.allSettled([poolA.end(),poolB.end()]);
    }
  }
});
