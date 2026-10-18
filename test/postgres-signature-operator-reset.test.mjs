import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { stat, mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { PATTERN_V2_SIGNATURE_COMPONENT, PATTERN_V2_SIGNATURE_CONTRACT_VERSION } from '../scripts/lib/pattern-v2-signature-contract.mjs';

const dbUrl = process.env.POSTGRES_URL;
const integrationTest = dbUrl ? test : test.skip;
const pg = dbUrl ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const execAsync = promisify(execFile);
const suffix = randomBytes(5).toString('hex');
const prefix = 'ei_sigreset_' + suffix;
const backupDb = 'ei_sigreset_backup_' + suffix;
const timestamp = '2026-10-18T11:00:00.000Z';
const tableKinds = ['metadata', 'counters', 'leases', 'history', 'records'];

function trigger() {
  return {
    triggerId: 'operator-managed-trigger',
    version: '1',
    conditionOnly: true,
    clauses: [{ id: 'invoice', event: 'invoice.paid', arguments: {}, where: [] }],
    pattern: { version: '2', root: { kind: 'event', ref: 'invoice' } },
    withinMs: 60000,
  };
}
function event() {
  return {
    traceId: 'replayed-by-operator',
    sourceEventId: 'external-audited-event-1',
    name: 'invoice.paid',
    occurredAt: timestamp,
    serverId: 'operator-fixture',
    provider: 'external-replay-fixture',
    subscriptionArguments: {},
    data: { invoice: 'replayed-1' },
  };
}

function pgEnv(database = null) {
  const url = new URL(dbUrl);
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database ?? decodeURIComponent(url.pathname.slice(1)),
  };
}
async function pgCli(binary, args, database) {
  try {
    await execAsync(binary, args, {
      env: pgEnv(database),
      timeout: 60000,
      maxBuffer: 512000,
    });
  } catch (error) {
    // Never leak postgres credentials in CI diagnostics.
    const message = String(error?.stderr || error?.message || error)
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]');
    throw new Error(binary + ' failed: ' + message.slice(0, 900));
  }
}

integrationTest('operator-managed PG backup/reset/replay fences old candidate identity', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ei-signature-operator-'));
  const archive = path.join(temp, 'legacy-incompatible.dump');
  const sourcePool = new Pool({ connectionString: dbUrl, max: 3 });
  let restorePool = null;
  let createdDb = false;
  const storeOptions = { tablePrefix: prefix, scopeId: 'tenant-A' };
  const makeSource = () => new PostgresEventStore({ pool: sourcePool, ...storeOptions });
  try {
    const old = makeSource();
    await old.init();
    await old.putTrigger(trigger());
    await old.ensureWakeDelivery({
      wakeId: 'legacy-unreconciled-wake', matchId: 'legacy-candidate-id',
      triggerId: trigger().triggerId, triggerVersion: '1',
      runtime: 'host', now: timestamp,
    });
    const receipt = await old.claimWakeDelivery('legacy-unreconciled-wake', {
      workerId: 'old-worker', now: timestamp, leaseMs: 1000,
    });
    assert.ok(receipt);
    await old.completeWakeDelivery('legacy-unreconciled-wake', {
      workerId: 'old-worker', attemptCount: receipt.attemptCount,
      runtimeReceiptId: 'legacy-host-turn-receipt', now: timestamp,
    });
    const markerTable = '"' + prefix + '_metadata"';
    // Emulate a store written by a pre-signature-marker binary, WITHOUT
    // modifying physical schema v1. The actual current binary must refuse it.
    await sourcePool.query('DELETE FROM ' + markerTable + ' WHERE component = $1',
      [PATTERN_V2_SIGNATURE_COMPONENT]);
    await assert.rejects(makeSource().init(),
      e => e?.code === 'EVENT_INTELLIGENCE_PATTERN_V2_SIGNATURE_INCOMPATIBLE');

    // An operator takes a real logical backup BEFORE destructive reset.
    const entries = tableKinds.map(kind => ['--table', prefix + '_' + kind]).flat();
    entries.push('--table', prefix + '_history_history_id_seq');
    await pgCli('pg_dump', ['--format=custom', '--no-owner', '--no-privileges',
      '--file', archive, ...entries]);
    assert.ok((await stat(archive)).size > 0, 'backup must not be empty');

    // Restore into an independent database. This is an integrity check,
    // not an upgrade to the new signature contract.
    await sourcePool.query('CREATE DATABASE "' + backupDb + '"');
    createdDb = true;
    await pgCli('pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges',
      '--dbname', backupDb, archive], backupDb);
    const restoredUrl = new URL(dbUrl);
    restoredUrl.pathname = '/' + backupDb;
    restorePool = new Pool({ connectionString: restoredUrl.toString(), max: 2 });
    const recoveredLegacy = new PostgresEventStore({
      pool: restorePool, ...storeOptions,
    });
    await assert.rejects(recoveredLegacy.init(),
      e => e?.code === 'EVENT_INTELLIGENCE_PATTERN_V2_SIGNATURE_INCOMPATIBLE',
      'restored pre-v1 state must not silently acquire new signature marker');

    const backupRows = await restorePool.query(
      'SELECT count(*)::int AS n FROM "' + prefix + '_records"' +
      " WHERE kind = 'trigger' OR kind = 'wake_delivery'",
    );
    assert.equal(backupRows.rows[0].n, 2, 'verified backup must retain old trigger/receipt');
    const archivedReceipt = await restorePool.query(
      'SELECT payload FROM "' + prefix + '_records"' +
      " WHERE kind = 'wake_delivery'",
    );
    assert.equal(archivedReceipt.rows[0].payload.runtimeReceiptId,
      'legacy-host-turn-receipt');

    // The operator explicitly chooses to reset the isolated source tables.
    // The verified backup stays independently accessible and unchanged.
    for (const kind of tableKinds) {
      await sourcePool.query('DROP TABLE "' + prefix + '_' + kind + '" CASCADE');
    }
    const fresh = makeSource();
    await fresh.init();
    assert.equal((await fresh.listTriggers()).length, 0);
    assert.equal(await fresh.getWakeDelivery('legacy-unreconciled-wake'), null,
      'old host receipt must not be silently carried across a reset');
    const freshMarker = await sourcePool.query(
      'SELECT version FROM "' + prefix + '_metadata" WHERE component = $1',
      [PATTERN_V2_SIGNATURE_COMPONENT],
    );
    assert.equal(Number(freshMarker.rows[0]?.version), PATTERN_V2_SIGNATURE_CONTRACT_VERSION);

    // Recreating the trigger and replaying an operator-selected upstream
    // event are explicit actions; never restore old match/deadline IDs.
    const engine = new CompositeTriggerEngine(fresh);
    await engine.register(trigger());
    const replay = await engine.ingest(event());
    assert.ok(replay.some(result => result.matched),
      'replayed authoritative external event must satisfy the new Pattern');
    assert.equal((await fresh.listTriggerMatches(trigger().triggerId)).length > 0,true);
    assert.equal(await fresh.getWakeDelivery('legacy-unreconciled-wake'), null);
    assert.equal((await recoveredLegacy.pool.query(
      'SELECT count(*)::int AS n FROM "' + prefix + '_records"' +
      " WHERE kind = 'trigger' OR kind = 'wake_delivery'",
    )).rows[0].n, 2,
    'archived legacy snapshot must remain intact after source reset/replay');
  } finally {
    if (restorePool) await restorePool.end();
    if (createdDb) await sourcePool.query('DROP DATABASE IF EXISTS "' + backupDb + '"');
    for (const kind of tableKinds) {
      await sourcePool.query('DROP TABLE IF EXISTS "' + prefix + '_' + kind + '" CASCADE');
    }
    await sourcePool.end();
    await rm(temp, { recursive: true, force: true });
  }
});
