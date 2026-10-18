import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';

const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integration = url ? test : test.skip;
const now = '2026-10-18T12:00:00.000Z';

function definition(id, event, serverId, lifecycle = {}) {
  return {
    triggerId: id, version: '1', conditionOnly: false,
    target: { runtime: 'fixture-host', kind: 'task', id },
    clauses: [
      { id: 'a', event,
        ...(serverId ? { serverId } : {}),
        arguments: { repository: 'acme/repo' },
        where: [{ path: 'slot', op: 'eq', value: 1 }] },
    ],
    pattern: { version: '2', root: { kind: 'event', ref: 'a' } },
    withinMs: 60000, lifecycle,
  };
}
function occurrence(id, event, serverId, slot = 1) {
  return {
    traceId: 'trace-' + id,
    sourceEventId: id,
    name: event, serverId,
    occurredAt: now,
    subscriptionArguments: { repository: 'acme/repo' },
    data: { slot },
  };
}
function ids(rows) {
  return rows.map(row => row.triggerId).sort();
}

integration('PG candidate projection sees live source changes, server wildcard and lifecycle transitions without cross-scope leaks', async () => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const prefix = 'ei_source_route_' + randomBytes(5).toString('hex');
  const store = new PostgresEventStore({
    pool, tablePrefix: prefix, scopeId: 'tenant-routing-A',
  });
  const other = new PostgresEventStore({
    pool, tablePrefix: prefix, scopeId: 'tenant-routing-B',
  });
  const tables = ['metadata', 'counters', 'leases', 'history', 'records'];
  try {
    await store.init();
    await other.init();
    const definitions = [
      definition('a-target', 'issue.updated', 'github-server-A'),
      definition('b-target', 'issue.updated', 'github-server-B'),
      definition('wildcard', 'issue.updated', undefined),
      definition('unrelated', 'invoice.paid', 'github-server-A'),
      definition('expired-elsewhere', 'invoice.paid', 'github-server-B',
        { expiresAt: '2020-01-01T00:00:00.000Z' }),
      definition('one-shot-elsewhere', 'invoice.paid', 'github-server-B',
        { oneShot: true }),
      definition('max-firings-elsewhere', 'invoice.paid', 'github-server-B',
        { maxFirings: 1 }),
    ];
    for (const d of definitions) await store.putTrigger(d);
    await store.putTrigger(definition('other-tenant', 'issue.updated', 'github-server-A'));
    await other.putTrigger(definition('B-only', 'issue.updated', 'github-server-A'));

    const projectionA = await store.listTriggerCandidatesForEvent({
      name: 'issue.updated', serverId: 'github-server-A',
    });
    assert.deepEqual(ids(projectionA), [
      'a-target','expired-elsewhere','max-firings-elsewhere',
      'one-shot-elsewhere','wildcard','other-tenant',
    ].sort(), 'projection must include all possible side-effect candidates');
    assert.ok(!ids(projectionA).includes('B-only'), 'tenant B must be isolated');
    assert.ok(!ids(projectionA).includes('unrelated'));
    assert.ok(!ids(projectionA).includes('b-target'));

    const before = await store.listTriggerCandidatesForEvent({
      name: 'new.source', serverId: 'server-C',
    });
    assert.deepEqual(ids(before), [
      'expired-elsewhere', 'max-firings-elsewhere','one-shot-elsewhere',
    ]);

    // Dynamic creation is visible without reloading any cached index.
    await store.putTrigger(definition('newly-registered', 'new.source', 'server-C'));
    const after = await store.listTriggerCandidatesForEvent({
      name: 'new.source', serverId: 'server-C',
    });
    assert.ok(ids(after).includes('newly-registered'));
    await store.setTriggerState('newly-registered', '1', 'paused');
    assert.ok(ids(await store.listTriggerCandidatesForEvent({
      name: 'new.source', serverId: 'server-C',
    })).includes('newly-registered'), 'do not filter mutable state in SQL');
    await store.setTriggerState('newly-registered', '1', 'deleted');
    assert.ok(ids(await store.listTriggerCandidatesForEvent({
      name: 'new.source', serverId: 'server-C',
    })).includes('newly-registered'), 'revoked trigger still has to be checked by engine');

    // Actual engine ingest must call this projection (never load all triggers
    // via an old store-specific fallback), then enforce its live state gate.
    const originalList = store.listTriggers.bind(store);
    store.listTriggers = async () => {
      throw new Error('ingest unexpectedly fetched all trigger definitions');
    };
    const engine = new CompositeTriggerEngine(store, null, () => new Date(now));
    const result = await engine.ingest(
      occurrence('evt-1', 'issue.updated', 'github-server-A'));
    assert.deepEqual(result.filter(row => row.matched).map(row => row.triggerId).sort(),
      ['a-target', 'wildcard', 'other-tenant'].sort());
    const expiry = await store.getTriggerState('expired-elsewhere', '1');
    assert.equal(expiry.status, 'expired',
      'expiry side effects must remain on unrelated events');
    await store.setTriggerState('a-target', '1', 'paused');
    const replay = await engine.ingest(
      occurrence('evt-2', 'issue.updated', 'github-server-A'));
    assert.ok(replay.every(row => row.triggerId !== 'a-target'),
      'paused matching definition must be denied by fresh state');

    store.listTriggers = originalList;
    const bCandidates = await other.listTriggerCandidatesForEvent({
      name: 'issue.updated', serverId: 'github-server-A',
    });
    assert.deepEqual(ids(bCandidates), ['B-only']);

    // Engine timer path bypasses store optimization intentionally; the
    // original timer/deadline contract is preserved by construction.
  } finally {
    for (const suffix of tables) {
      await pool.query('DROP TABLE IF EXISTS "' + prefix + '_' + suffix + '" CASCADE');
    }
    await pool.end();
  }
});
