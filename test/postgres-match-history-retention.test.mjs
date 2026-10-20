import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';

import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';

const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integration = url ? test : test.skip;
const cutoff = '2026-10-10T00:00:00.000Z';

function record(matchId, status = 'fired', updatedAt = '2026-10-05T10:00:00.000Z') {
  return {
    protocolVersion: '0.2.0',
    schemaVersion: 'trigger.v0.2',
    matchId,
    triggerId: 'retention-trigger',
    triggerVersion: '1',
    status,
    partitionKey: null,
    openedAt: '2026-10-05T10:00:00.000Z',
    expiresAt: '2026-10-05T10:01:00.000Z',
    updatedAt,
    sourceEvents: [],
    semanticDecision: null,
    patternState: {
      version: '2',
      role: 'match',
      signature: matchId,
      semanticDecisions: [],
    },
    firedWakeId: status === 'fired' ? 'retention-wake-' + matchId : null,
    derivedEventIds: [],
  };
}
function sameHistory(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

integration('PG16 operator match-history compaction prunes only exact adjacent redundant fired snapshots', async () => {
  const prefix = 'ei_revret_' + randomBytes(5).toString('hex');
  const poolA = new Pool({ connectionString: url, max: 4 });
  const poolB = new Pool({ connectionString: url, max: 4 });
  const a = new PostgresEventStore({ pool: poolA, dispatchPoolIdentity: poolA, tablePrefix: prefix, scopeId: 'tenant-A' });
  const contender = new PostgresEventStore({ pool: poolB, dispatchPoolIdentity: poolB, tablePrefix: prefix, scopeId: 'tenant-A' });
  const b = new PostgresEventStore({ pool: poolB, dispatchPoolIdentity: poolB, tablePrefix: prefix, scopeId: 'tenant-B' });
  const finishedId = 'terminal-with-runs';
  const activeId = 'still-matched';
  const historyTable = '"' + prefix + '_history"';
  try {
    await Promise.all([a.init(), contender.init(), b.init()]);
    // AAAAAA -> BB -> CCC; only the four INTERIOR A rows and
    // one INTERIOR C row can be pruned. Distinct B stays intact.
    const A = record(finishedId);
    const B = record(finishedId, 'fired', '2026-10-05T10:00:01.000Z');
    const C = record(finishedId, 'fired', '2026-10-05T10:00:02.000Z');
    for (const [value, n] of [[A, 6], [B, 2], [C, 3]]) {
      for (let i = 0; i < n; i++) await a.appendTriggerMatch(value);
    }
    for (let i = 0; i < 4; i++) await b.appendTriggerMatch(A);
    for (let i = 0; i < 4; i++) await a.appendTriggerMatch(record(activeId, 'matched'));
    const old = '2026-10-08T12:00:00Z';
    await poolA.query(
      'UPDATE ' + historyTable + ' SET created_at=$1::timestamptz' +
      ' WHERE scope_id IN ($2,$3) AND kind=$4',
      [old, 'tenant-A', 'tenant-B', 'trigger_match_history'],
    );

    await a.ensureWakeDelivery({
      wakeId: 'retention-wake-' + finishedId,
      matchId: finishedId,
      triggerId: 'retention-trigger',
      triggerVersion: '1',
      runtime: 'fixture-host',
      now: '2026-10-05T10:00:00.000Z',
    });
    const claim = await a.claimWakeDelivery('retention-wake-' + finishedId, {
      workerId: 'retention-worker',
      now: '2026-10-05T10:00:00.000Z',
      leaseMs: 1000,
    });
    assert.ok(claim);
    await a.completeWakeDelivery('retention-wake-' + finishedId, {
      workerId: 'retention-worker',
      attemptCount: claim.attemptCount,
      runtimeReceiptId: 'host-persistent-receipt',
      now: '2026-10-05T10:00:00.500Z',
    });
    await a.appendAudit({
      auditId: 'retention-audit',
      traceId: 'retention-trace',
      timestamp: '2026-10-05T10:00:00.000Z',
      kind: 'trigger.created',
      entityType: 'trigger',
      entityId: 'retention-trigger',
      details: { evidence: 'do-not-remove' },
    });
    const original = await a.listTriggerMatchHistory(finishedId);
    assert.equal(original.length, 11);
    assert.equal(await a.verifyAudit(), true);

    const preview = await a.compactTerminalMatchDuplicateHistory({
      matchId: finishedId, before: cutoff, maxRows: 2,
    });
    assert.deepEqual(
      { eligible: preview.eligible, deleted: preview.deleted, dryRun: preview.dryRun, capped: preview.capped },
      { eligible: 2, deleted: 0, dryRun: true, capped: true },
    );
    assert.equal((await a.listTriggerMatchHistory(finishedId)).length, 11,
      'default dry-run must not modify history');
    const initial = await a.compactTerminalMatchDuplicateHistory({
      matchId: finishedId, before: cutoff, maxRows: 2, dryRun: false,
    });
    assert.equal(initial.deleted, 2);
    const concurrent = await Promise.all([
      a.compactTerminalMatchDuplicateHistory({
        matchId: finishedId, before: cutoff, maxRows: 3, dryRun: false,
      }),
      contender.compactTerminalMatchDuplicateHistory({
        matchId: finishedId, before: cutoff, maxRows: 3, dryRun: false,
      }),
    ]);
    assert.equal(concurrent[0].deleted + concurrent[1].deleted, 3,
      'independent PG pools cannot double-delete history');
    assert.equal((await contender.compactTerminalMatchDuplicateHistory({
      matchId: finishedId, before: cutoff, dryRun: false,
    })).deleted, 0, 'repeating compaction must be idempotent');
    const remained = await contender.listTriggerMatchHistory(finishedId);
    assert.equal(remained.length, 6);
    assert.deepEqual(remained, [A, A, B, B, C, C],
      'preserve first/last of every identical run and all distinct transitions');
    assert.ok(sameHistory((await a.listTriggerMatches('retention-trigger'))
      .find(row => row.matchId === finishedId), C),
      'current authoritative fired match is not compacted');
    assert.equal((await b.listTriggerMatchHistory(finishedId)).length, 4,
      'same match ID in another tenant scope must stay intact');
    assert.equal((await a.listTriggerMatchHistory(activeId)).length, 4,
      'nonterminal match revisions cannot be compacted');
    assert.deepEqual((await contender.getRecentTriggerMatchHistory(
      finishedId, { limit: 2 },
    )).records, [C, C]);
    assert.equal((await a.getWakeDelivery('retention-wake-' + finishedId))
      .runtimeReceiptId, 'host-persistent-receipt');
    assert.equal(await a.claimWakeDelivery('retention-wake-' + finishedId, {
      workerId: 'not-allowed',
      now: '2026-10-05T10:00:05.000Z',
    }), null, 'durably delivered wake must not be redispatched');
    assert.equal(await contender.verifyAudit(), true);
    assert.equal((await contender.listAudit()).length, 1);

    assert.equal((await a.compactTerminalMatchDuplicateHistory({
      matchId: activeId, before: cutoff, dryRun: false,
    })).skipped, 'not_fired');
    for (const invalid of [
      {}, { matchId: finishedId, before: 'no-date' },
      { matchId: finishedId, before: '2026-10-10' },
      { matchId: finishedId, before: '2999-01-01T00:00:00Z' },
      { matchId: finishedId, before: cutoff, maxRows: 0 },
      { matchId: finishedId, before: cutoff, maxRows: 1001 },
      { matchId: finishedId, before: cutoff, dryRun: 'false' },
    ]) {
      await assert.rejects(
        () => a.compactTerminalMatchDuplicateHistory(invalid),
        e => e.code === 'EVENT_INTELLIGENCE_MATCH_HISTORY_RETENTION_INVALID',
      );
    }
  } finally {
    // No cleanup while a second worker could still be writing.
    try {
      for (const suffix of ['metadata', 'leases', 'history', 'records', 'counters']) {
        await poolA.query('DROP TABLE IF EXISTS "' + prefix + '_' + suffix + '" CASCADE');
      }
    } finally {
      await Promise.allSettled([poolA.end(), poolB.end()]);
    }
  }
});
