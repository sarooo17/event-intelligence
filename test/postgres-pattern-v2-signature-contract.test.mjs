import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { PATTERN_V2_SIGNATURE_COMPONENT, PATTERN_V2_SIGNATURE_CONTRACT_VERSION } from '../scripts/lib/pattern-v2-signature-contract.mjs';

const url = process.env.POSTGRES_URL;
const integration = url ? test : test.skip;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;

integration('PG16 signature manifest rejects old/unknown candidate identities atomically', async () => {
  const pool = new Pool({ connectionString: url, max: 3 });
  const prefix = 'ei_signature_' + randomBytes(5).toString('hex');
  const store = new PostgresEventStore({ pool, tablePrefix: prefix });
  const metadata = '"' + prefix + '_metadata"';
  const records = '"' + prefix + '_records"';
  const suffixes = ['metadata', 'counters', 'leases', 'history', 'records'];
  try {
    await store.init();
    const initial = await pool.query(
      'SELECT version FROM ' + metadata + ' WHERE component = $1',
      [PATTERN_V2_SIGNATURE_COMPONENT],
    );
    assert.equal(Number(initial.rows[0]?.version), PATTERN_V2_SIGNATURE_CONTRACT_VERSION);
    await store.putTrigger({
      triggerId: 'pattern-v2-state', version: '1', conditionOnly: true,
      clauses: [{ id: 'a', event: 'invoice.opened', where: [], arguments: {} }],
      pattern: { version: '2', root: { kind: 'event', ref: 'a' } },
      withinMs: 60000,
    });
    const before = await pool.query(
      'SELECT count(*)::int AS n FROM ' + records + " WHERE kind = 'trigger'");
    assert.equal(before.rows[0]?.n, 1);
    const reopen = new PostgresEventStore({ pool, tablePrefix: prefix });
    await reopen.init();
    assert.equal((await reopen.listTriggers()).length, 1);

    await pool.query('DELETE FROM ' + metadata + ' WHERE component = $1',
      [PATTERN_V2_SIGNATURE_COMPONENT]);
    await assert.rejects(
      new PostgresEventStore({ pool, tablePrefix: prefix }).init(),
      error => error?.code === 'EVENT_INTELLIGENCE_PATTERN_V2_SIGNATURE_INCOMPATIBLE',
    );
    const after = await pool.query(
      'SELECT count(*)::int AS n FROM ' + records + " WHERE kind = 'trigger'");
    assert.equal(after.rows[0]?.n, 1, 'failed init must not delete durable trigger');
    const absent = await pool.query(
      'SELECT count(*)::int AS n FROM ' + metadata + ' WHERE component = $1',
      [PATTERN_V2_SIGNATURE_COMPONENT]);
    assert.equal(absent.rows[0]?.n, 0, 'failed init must roll back manifest adoption');

    await pool.query('INSERT INTO ' + metadata + ' (component, version) VALUES ($1, $2)',
      [PATTERN_V2_SIGNATURE_COMPONENT, 999]);
    await assert.rejects(
      new PostgresEventStore({ pool, tablePrefix: prefix }).init(),
      error => error?.code === 'EVENT_INTELLIGENCE_PATTERN_V2_SIGNATURE_INCOMPATIBLE',
    );
    await pool.query('UPDATE ' + metadata + ' SET version = $2 WHERE component = $1',
      [PATTERN_V2_SIGNATURE_COMPONENT, PATTERN_V2_SIGNATURE_CONTRACT_VERSION]);
    const restored = new PostgresEventStore({ pool, tablePrefix: prefix });
    await restored.init();
    assert.equal((await restored.listTriggers()).length, 1);
  } finally {
    for (const suffix of suffixes) {
      await pool.query('DROP TABLE IF EXISTS "' + prefix + '_' + suffix + '" CASCADE');
    }
    await pool.end();
  }
});
