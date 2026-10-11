import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';

const url = process.env.POSTGRES_URL;
const integrationTest = url ? test : test.skip;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;

function id() {
  return 'ei_ret_' + randomBytes(6).toString('hex');
}

function store(pool, prefix, scopeId) {
  return new PostgresEventStore({ pool, tablePrefix: prefix, scopeId });
}

integrationTest('PostgreSQL retention prunes only old tenant semantic cache, never audited/durable state', async () => {
  const pool = new Pool({ connectionString: url, max: 6 });
  const prefix = id();
  const a = store(pool, prefix, 'tenant-A');
  const b = store(pool, prefix, 'tenant-B');
  try {
    await Promise.all([a.init(), b.init()]);
    const indexInfo = await pool.query(
      'SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1',
      [prefix + '_records_age_idx'],
    );
    assert.equal(indexInfo.rows.length, 1, 'bounded TTL should have a dedicated ordered index');
    assert.match(
      indexInfo.rows[0].indexdef,
      /scope_id, kind, updated_at, record_key/,
    );
    const decision = { matched: true, evaluator: 'fixture:v1', probability: 0.9 };
    await a.putSemanticDecisionCache('old-1', decision);
    await a.putSemanticDecisionCache('old-2', decision);
    await a.putSemanticDecisionCache('new', decision);
    await b.putSemanticDecisionCache('old-1', { matched: false });
    const audit = {
      auditId: 'audit-retain-1', traceId: 'trace-retain',
      timestamp: '2026-10-10T12:00:00.000Z',
      kind: 'trigger.created', entityType: 'trigger',
      entityId: 'trigger-retain', details: { evidence: 'must-stay' },
    };
    await a.appendAudit(audit);
    await a.ensureWakeDelivery({
      wakeId: 'wake-retain', matchId: 'match-retain',
      triggerId: 'trigger-retain', triggerVersion: '1',
      runtime: 'host-retain', now: '2026-10-10T12:00:00.000Z',
    });
    const oldAt = '2026-10-09T10:00:00.000Z';
    const newAt = '2026-10-11T10:00:00.000Z';
    await pool.query(
      'UPDATE "' + prefix + '_records"' +
      " SET updated_at = CASE WHEN record_key = 'new'" +
      ' THEN $3::timestamptz ELSE $2::timestamptz END' +
      " WHERE scope_id = $1 AND kind = 'semantic_cache'",
      ['tenant-A', oldAt, newAt],
    );
    await pool.query(
      'UPDATE "' + prefix + '_records"' +
      ' SET updated_at = $2::timestamptz' +
      " WHERE scope_id = $1 AND kind = 'semantic_cache'",
      ['tenant-B', oldAt],
    );
    const noPolicy = await a.compactMutableState();
    assert.equal(noPolicy.strategy, 'database-managed');
    assert.equal(await a.semanticDecisionCacheSize(), 3);

    const retention = await a.compactMutableState({
      semanticCacheBefore: '2026-10-10T00:00:00.000Z',
      maxRows: 1,
    });
    assert.equal(retention.strategy, 'bounded-semantic-cache-retention');
    assert.equal(retention.deleted, 1);
    assert.equal(retention.capped, true);
    assert.equal(await a.semanticDecisionCacheSize(), 2);
    const another = await a.compactMutableState({
      semanticCacheBefore: '2026-10-10T00:00:00.000Z',
      maxRows: 20,
    });
    assert.equal(another.deleted, 1);
    assert.equal(another.capped, false);
    assert.equal(await a.semanticDecisionCacheSize(), 1);
    assert.deepEqual(await a.getSemanticDecisionCache('new'), decision);
    assert.deepEqual(await b.getSemanticDecisionCache('old-1'), { matched: false });
    assert.equal(await b.semanticDecisionCacheSize(), 1);
    assert.equal((await a.getWakeDelivery('wake-retain')).status, 'pending');
    assert.equal(await a.verifyAudit(), true);
    assert.equal((await a.listAudit()).length, 1);

    // A second worker with independent store authority must not observe
    // deleted decisions after a cold reinitialization.
    const reopened = store(pool, prefix, 'tenant-A');
    await reopened.init();
    assert.equal(await reopened.getSemanticDecisionCache('old-1'), null);
    assert.equal(await reopened.getSemanticDecisionCache('old-2'), null);
    assert.deepEqual(await reopened.getSemanticDecisionCache('new'), decision);
  } finally {
    for (const suffix of ['metadata','leases','history','records','counters']) {
      await pool.query('DROP TABLE IF EXISTS "' + prefix + '_' + suffix + '" CASCADE');
    }
    await pool.end();
  }
});

integrationTest('PostgreSQL cache retention rejects invalid policies and is concurrency-safe', async () => {
  const pool = new Pool({ connectionString: url, max: 8 });
  const prefix = id();
  const a = store(pool, prefix, 'tenant-concurrent');
  const b = store(pool, prefix, 'tenant-concurrent');
  try {
    await Promise.all([a.init(), b.init()]);
    for (let i = 0; i < 8; i++) {
      await a.putSemanticDecisionCache('cache-' + i, { matched: false });
    }
    await pool.query(
      'UPDATE "' + prefix + '_records"' +
      ' SET updated_at = $2::timestamptz' +
      " WHERE scope_id = $1 AND kind = 'semantic_cache'",
      ['tenant-concurrent', '2026-10-09T00:00:00.000Z'],
    );
    for (const input of [
      { semanticCacheBefore: '2026-10-10', maxRows: 2 },
      { semanticCacheBefore: 'not-a-date', maxRows: 2 },
      { semanticCacheBefore: '2026-10-10T00:00:00Z', maxRows: 0 },
      { semanticCacheBefore: '2026-10-10T00:00:00Z', maxRows: 1001 },
      { semanticCacheBefore: '2026-10-10T00:00:00Z', maxRows: 1.5 },
    ]) {
      await assert.rejects(
        () => a.compactMutableState(input),
        error => error?.code === 'EVENT_INTELLIGENCE_RETENTION_POLICY_INVALID',
      );
    }
    assert.equal(await a.semanticDecisionCacheSize(), 8);
    const [x,y] = await Promise.all([
      a.compactMutableState({ semanticCacheBefore: '2026-10-10T00:00:00Z', maxRows: 5 }),
      b.compactMutableState({ semanticCacheBefore: '2026-10-10T00:00:00Z', maxRows: 5 }),
    ]);
    assert.equal(x.deleted + y.deleted, 8, 'concurrent workers must not double-count deleted decisions');
    assert.equal(await a.semanticDecisionCacheSize(), 0);
  } finally {
    for (const suffix of ['metadata','leases','history','records','counters']) {
      await pool.query('DROP TABLE IF EXISTS "' + prefix + '_' + suffix + '" CASCADE');
    }
    await pool.end();
  }
});
