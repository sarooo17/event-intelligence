import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';

const dbUrl = process.env.POSTGRES_URL;
const integrationTest = dbUrl ? test : test.skip;
const pg = dbUrl ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const execFileAsync = promisify(execFile);
const suffix = randomBytes(5).toString('hex');
const tablePrefix = 'ei_logical_' + suffix;
const restoredDatabase = 'ei_logical_restore_' + suffix;
const suffixes = ['metadata', 'leases', 'history', 'records', 'counters'];
const timestamp = '2026-10-10T12:00:00.000Z';

function cliEnv(database) {
  const u = new URL(dbUrl);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: database ?? decodeURIComponent(u.pathname.slice(1)),
  };
}

async function runPg(tool, args, database) {
  try {
    await execFileAsync(tool, args, {
      env: cliEnv(database),
      timeout: 60_000,
      maxBuffer: 512_000,
    });
  } catch (error) {
    // No DSN or credential appears in argv. Keep diagnostic output bounded.
    const sanitized = String(error?.stderr || error?.message || error)
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]');
    throw new Error(tool + ' failed: ' + sanitized.slice(0, 1200));
  }
}

function definition() {
  return {
    triggerId: 'logical-restore-trigger',
    version: '1', conditionOnly: true,
    clauses: [{ id: 'a', event: 'restore.ready', arguments: {}, where: [] }],
    pattern: { version: '2', root: { kind: 'event', ref: 'a' } },
    withinMs: 60000,
  };
}

integrationTest('pg_dump + pg_restore preserves trigger, audit chain, wake receipt and replay fence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-logical-restore-'));
  const archive = path.join(dir, 'snapshot.dump');
  const sourcePool = new Pool({ connectionString: dbUrl, max: 3 });
  let targetPool;
  let createdDatabase = false;
  try {
    const source = new PostgresEventStore({
      pool: sourcePool, tablePrefix, scopeId: 'tenant-logical',
    });
    await source.init();
    await source.putTrigger(definition());
    await source.setTriggerState(
      'logical-restore-trigger', '1', 'paused',
      { type: 'system', principal_id: 'recovery-fixture' },
    );
    await source.appendAudit({
      auditId: 'logical-audit-1', traceId: 'logical-trace',
      timestamp, kind: 'trigger.created', entityType: 'trigger',
      entityId: 'logical-restore-trigger', details: { fixture: 'snapshot' },
    });
    const wakeId = 'logical-restore-wake';
    await source.ensureWakeDelivery({
      wakeId, matchId: 'logical-restore-match',
      triggerId: 'logical-restore-trigger', triggerVersion: '1',
      runtime: 'fixture-host', now: timestamp,
    });
    const claimed = await source.claimWakeDelivery(wakeId, {
      workerId: 'worker-before-snapshot', now: timestamp, leaseMs: 30000,
    });
    assert.ok(claimed);
    await source.completeWakeDelivery(wakeId, {
      workerId: 'worker-before-snapshot', attemptCount: claimed.attemptCount,
      runtimeReceiptId: 'receipt-original', now: timestamp,
    });
    const originalDefinitions = await source.listTriggers();
    assert.equal(await source.verifyAudit(), true);

    const patterns = suffixes.map(s => ['--table', tablePrefix + '_' + s]).flat();
    // Explicitly include the owned BIGSERIAL sequence as well, so subsequent
    // audit/history appends after restore cannot silently collide with IDs.
    patterns.push('--table', tablePrefix + '_history_history_id_seq');
    await runPg('pg_dump', ['--format=custom', '--no-owner', '--no-privileges',
      '--file', archive, ...patterns]);
    await sourcePool.query('CREATE DATABASE "' + restoredDatabase + '"');
    createdDatabase = true;
    await runPg('pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges',
      '--dbname', restoredDatabase, archive], restoredDatabase);

    const restoredUrl = new URL(dbUrl);
    restoredUrl.pathname = '/' + restoredDatabase;
    targetPool = new Pool({ connectionString: restoredUrl.toString(), max: 3 });
    const target = new PostgresEventStore({
      pool: targetPool, tablePrefix, scopeId: 'tenant-logical',
    });
    await target.init();
    assert.deepEqual(await target.listTriggers(), originalDefinitions);
    assert.equal((await target.getTriggerState('logical-restore-trigger', '1')).status, 'paused');
    assert.equal((await target.getWakeDelivery(wakeId)).runtimeReceiptId, 'receipt-original');
    assert.equal(await target.claimWakeDelivery(wakeId, {
      workerId: 'worker-after-restore',
      now: '2026-10-10T13:00:00.000Z', leaseMs: 1000,
    }), null, 'delivered wake must not be re-claimed after logical restore');
    assert.equal(await target.verifyAudit(), true);
    assert.equal((await target.listAudit()).length, 1);

    await target.appendAudit({
      auditId: 'logical-audit-2', traceId: 'logical-trace',
      timestamp, kind: 'trigger.paused', entityType: 'trigger',
      entityId: 'logical-restore-trigger', details: { fixture: 'post-restore' },
    });
    assert.equal((await target.listAudit()).length, 2);
    assert.equal(await target.verifyAudit(), true);
    assert.deepEqual(await target.forScope('other-tenant').then(
      scoped => scoped.listTriggers()
    ), [], 'no cross-tenant trigger leakage after restore');
  } finally {
    if (targetPool) await targetPool.end();
    if (createdDatabase) {
      // Never terminate connection pools by FORCE: if sessions remain,
      // fail explicitly and expose their lifecycle bug instead of causing
      // an unhandled asynchronous postgres client termination.
      await sourcePool.query('DROP DATABASE IF EXISTS "' + restoredDatabase + '"');
    }
    for (const suffixName of suffixes) {
      await sourcePool.query('DROP TABLE IF EXISTS "' +
        tablePrefix + '_' + suffixName + '" CASCADE');
    }
    await sourcePool.end();
    await rm(dir, { recursive: true, force: true });
  }
});
