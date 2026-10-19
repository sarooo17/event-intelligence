import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';

const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integration = url ? test : test.skip;
const occurredAt = '2026-10-18T12:00:00.000Z';
const eq = (path, value) => ({ op: 'eq', path, value });

function definition(triggerId, {
  where = [eq('slot', 7)],
  event = 'fixture.changed',
  serverId = undefined,
  clauses = null,
  lifecycle = {},
} = {}) {
  return {
    triggerId, version: '1',
    clauses: clauses ?? [{
      id: 'c', event, ...(serverId ? { serverId } : {}),
      arguments: {}, where,
    }],
    pattern: { version: '2', root: { kind: 'event', ref: 'c' } },
    withinMs: 60000,
    lifecycle,
    target: { runtime: 'fixture-host', kind: 'task', id: triggerId },
  };
}
function ids(records) {
  return records.map(x => x.triggerId).sort();
}
function event(sourceEventId, data = { slot: 7, tag: 'okay' }) {
  return {
    traceId: 'trace-' + sourceEventId,
    sourceEventId,
    name: 'fixture.changed',
    serverId: 'server-A', occurredAt, data,
    subscriptionArguments: {},
  };
}

integration('PG source candidate numeric-eq prefilter is fail-open and never drops complex/lifecycle/tenant behavior', async () => {
  const prefix = 'ei_numeric_eq_' + randomBytes(5).toString('hex');
  const pool = new Pool({ connectionString: url, max: 4 });
  const store = new PostgresEventStore({ pool, tablePrefix: prefix, scopeId: 'tenant-A' });
  const other = new PostgresEventStore({ pool, tablePrefix: prefix, scopeId: 'tenant-B' });
  const tables = ['metadata', 'leases', 'history', 'records', 'counters'];
  try {
    await Promise.all([store.init(), other.init()]);
    const defs = [
      definition('match-seven'),
      definition('mismatch-eight', { where: [eq('slot', 8)] }),
      definition('different-event', { event: 'unrelated.event' }),
      definition('different-server', { serverId: 'server-B' }),
      definition('same-server', { serverId: 'server-A' }),
      definition('nested-unknown', { where: [eq('slot.deep', 7)] }),
      definition('string-constraint', { where: [eq('tag', 'okay')] }),
      definition('two-predicates', { where: [eq('slot', 7), eq('tag', 'okay')] }),
      definition('regex-constraint', { where: [{ path: 'tag', op: 'regex', value: '^ok' }] }),
      definition('numeric-fraction', { where: [eq('slot', 1.5)] }),
      definition('numeric-unsafe-constant', {
        where: [eq('slot', Number.MAX_SAFE_INTEGER + 10)],
      }),
      definition('lifecycle-expired', {
        event: 'unrelated.event',
        lifecycle: { expiresAt: '2020-01-01T00:00:00.000Z' },
      }),
      definition('lifecycle-one-shot', { event: 'unrelated.event', lifecycle: { oneShot: true } }),
      definition('lifecycle-max', { event: 'unrelated.event', lifecycle: { maxFirings: 1 } }),
      definition('alternate-clause', {
        clauses: [
          { id: 'c', event: 'fixture.changed', arguments: {}, where: [eq('slot', 8)] },
          { id: 'd', event: 'fixture.changed', arguments: {}, where: [eq('slot', 7)] },
        ],
      }),
      definition('paused-current-state'),
    ];
    for (const def of defs) await store.putTrigger(def);
    await other.putTrigger(definition('neighbor-only'));
    await store.setTriggerState('paused-current-state', '1', 'paused');

    const oldSourceCandidates = await store.listTriggerCandidatesForEvent({
      name: 'fixture.changed', serverId: 'server-A',
    });
    assert.ok(ids(oldSourceCandidates).includes('mismatch-eight'),
      'omitting event.data must preserve original source-only superset');

    const narrowed = await store.listTriggerCandidatesForEvent({
      name: 'fixture.changed', serverId: 'server-A',
      data: { slot: 7, tag: 'okay' },
    });
    const expected = [
      'match-seven', 'same-server', 'nested-unknown',
      'string-constraint', 'two-predicates', 'regex-constraint',
      'lifecycle-expired', 'lifecycle-one-shot', 'lifecycle-max',
      'alternate-clause', 'paused-current-state',
      'numeric-fraction', 'numeric-unsafe-constant',
    ].sort();
    assert.deepEqual(ids(narrowed), expected,
      'drop only provably false single direct-number eq candidates');
    assert.ok(!ids(narrowed).includes('neighbor-only'), 'no cross-tenant visibility');

    // Under invalid/ambiguous event.data, no numeric fast-path is applied.
    for (const data of [
      { slot: 1.5, tag: 'okay' },
      { slot: Number.MAX_SAFE_INTEGER + 10 },
      { slot: { deep: 7 } },
      { slot: 7, note: 'contains' + String.fromCharCode(0) + 'nul' },
      { slot: 7, ['nul' + String.fromCharCode(0)]: 'key' },
      { slot: 7, note: String.fromCharCode(0xd800) },
      { slot: 7, note: 'emoji ' + String.fromCodePoint(0x1f600) },
      [7],
      null,
    ]) {
      const fallback = await store.listTriggerCandidatesForEvent({
        name: 'fixture.changed', serverId: 'server-A', data,
      });
      assert.deepEqual(ids(fallback), ids(oldSourceCandidates));
    }

    const engine = new CompositeTriggerEngine(store, null,
      () => new Date(occurredAt));
    const current = await engine.ingest(event('positive-1'));
    assert.deepEqual(current.filter(x => x.matched).map(x => x.triggerId).sort(),
      ['match-seven', 'same-server', 'string-constraint',
        'two-predicates', 'regex-constraint'].sort(),
      'canonical matching still evaluates the full clause and current state');
    const expired = await store.getTriggerState('lifecycle-expired', '1');
    assert.equal(expired.status, 'expired',
      'unrelated expired lifecycle must still persist transition');
    assert.equal((await store.getTriggerState('paused-current-state', '1')).status,
      'paused');

    // Current PostgreSQL rows are observed immediately; no cache survives
    // registration or state mutations.
    await store.putTrigger(definition('created-after-first-event'));
    const freshlyAdded = await engine.ingest(event('positive-2'));
    assert.ok(freshlyAdded.some(x =>
      x.matched && x.triggerId === 'created-after-first-event'));
    assert.ok(!freshlyAdded.some(x =>
      x.matched && x.triggerId === 'paused-current-state'));
    assert.equal(await store.verifyAudit(), true);
  } finally {
    try {
      for (const suffix of tables) {
        await pool.query('DROP TABLE IF EXISTS "' + prefix + '_' + suffix + '" CASCADE');
      }
    } finally {
      await pool.end();
    }
  }
});
