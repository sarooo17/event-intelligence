import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { TriggerControlPlane } from '../scripts/lib/trigger-control-plane.mjs';
import { PATTERN_V2_SIGNATURE_COMPONENT } from '../scripts/lib/pattern-v2-signature-contract.mjs';

const connectionString = process.env.POSTGRES_URL;
const integration = connectionString ? test : test.skip;
const { Pool } = connectionString ? await import('pg') : { Pool: null };
const execAsync = promisify(execFile);
const suffix = randomBytes(5).toString('hex');
const prefix = 'ei_v1upgrade_' + suffix;
const sourceDb = 'ei_v1source_' + suffix;
const candidateDb = 'ei_v1candidate_' + suffix;
const rollbackDb = 'ei_v1rollback_' + suffix;
const stamp = '2026-11-04T10:00:00.000Z';
const ownerA = { type: 'user', principal_id: 'alice', tenant_id: 'tenant-a' };
const ownerB = { type: 'user', principal_id: 'bob', tenant_id: 'tenant-b' };
const epoch = 'operator-issued-independent-epoch-' + suffix.padEnd(34, 'a');
const connectionId = 'persistent-upstream';

function trigger() {
  return {
    triggerId: 'restore-pinned-trigger', version: '1', conditionOnly: true,
    clauses: [{ id: 'invoice', event: 'invoice.paid', arguments: {}, where: [] }],
    pattern: { version: '2', root: { kind: 'event', ref: 'invoice' } },
    withinMs: 60000,
  };
}
function occurrence(eventId) {
  return { eventId, name: 'invoice.paid', timestamp: stamp, data: { safe: true } };
}
function scoped(pool, scopeId) {
  return new PostgresEventStore({
    pool, dispatchPoolIdentity: pool, tablePrefix: prefix, scopeId,
    requireMcpSessionFence: true,
  });
}
function urlFor(database) {
  const url = new URL(connectionString);
  url.pathname = '/' + database;
  return url.toString();
}
function pgEnv(database) {
  const url = new URL(connectionString);
  return {
    ...process.env,
    PGHOST: url.hostname, PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
  };
}
async function pgCli(binary, args, database) {
  try {
    return await execAsync(binary, args, {
      env: pgEnv(database), timeout: 30000, maxBuffer: 256000,
    });
  } catch (error) {
    // Do not log or expose a URL, credentials or arbitrary provider content.
    const reason = String(error?.stderr || error?.message || error)
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]');
    throw new Error(binary + ' operator fixture failed: ' + reason.slice(0, 700));
  }
}
async function assertCatalog(pool) {
  // Check physical objects BEFORE init() could create a missing empty table.
  for (const kind of ['metadata', 'records', 'history', 'leases', 'counters']) {
    const relation = await pool.query('SELECT to_regclass($1) AS relation',
      ['"' + prefix + '_' + kind + '"']);
    assert.ok(relation.rows[0]?.relation, 'missing restored table ' + kind);
  }
  const sequence = await pool.query('SELECT to_regclass($1) AS relation',
    ['"' + prefix + '_history_history_id_seq"']);
  assert.ok(sequence.rows[0]?.relation, 'missing restored history sequence');
}
async function assertRestored(pool, expectedGap, expectedCheckpoint) {
  await assertCatalog(pool);
  const a = scoped(pool, 'tenant-a');
  const b = scoped(pool, 'tenant-b');
  await Promise.all([a.init(), b.init()]);
  const controlA = new TriggerControlPlane({ store: a });
  const controlB = new TriggerControlPlane({ store: b });
  assert.equal((await controlA.listTriggers({ owner: ownerA })).length, 1);
  assert.deepEqual(await controlA.listTriggers({ owner: ownerB }), []);
  assert.equal((await controlB.listTriggers({ owner: ownerB })).length, 1);
  assert.deepEqual(await controlB.listTriggers({ owner: ownerA }), []);
  assert.equal((await a.getTriggerState(trigger().triggerId, '1')).status, 'paused');
  assert.equal((await b.getTriggerState(trigger().triggerId, '1')).status, 'active');

  assert.equal((await a.getWakeDelivery('snapshot-wake')).runtimeReceiptId,
    'host-idempotent-effect-1');
  assert.equal(await a.claimWakeDelivery('snapshot-wake', {
    workerId: 'recovered-worker', now: '2026-11-05T12:00:00.000Z',
    leaseMs: 1000,
  }), null, 'a restored delivered wake must NEVER be dispatched again');
  assert.equal(await b.getWakeDelivery('snapshot-wake'), null,
    'same wake ID is not visible in the other tenant');

  const gap = await a.getMcpClientState(connectionId, 'invoice.failed',
    { source: { zone: 'eu', country: 'IT' } });
  assert.deepEqual(gap, expectedGap, 'cursor, identity and gap revision survive clone');
  assert.equal(gap.gapUnresolved, true);
  assert.equal((await a.getMcpOccurrenceArchiveCheckpoint()).endSequence,
    expectedCheckpoint.endSequence);
  assert.equal((await a.getMcpOccurrenceArchiveCheckpoint()).headHash,
    expectedCheckpoint.headHash);
  assert.equal(await a.verifyAudit(), true);
  assert.equal(await b.verifyAudit(), true);
  await assert.rejects(a.beginMcpConnectionAuthority({ connectionId, epoch }),
    error => error?.code === 'MCP_SESSION_REVOKED',
    'a revoked authority epoch must remain tombstoned across full restore');
  await assert.rejects(a.appendMcpOccurrence('provider', occurrence('stale'), 'sub',
    { connectionId, epoch }), error => error?.code === 'MCP_SESSION_REVOKED');
  return { a, b };
}

integration('v1 isolated FULL-database snapshot, cold clone, incompatible marker refusal and rollback', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ei-v1-operator-'));
  const archive = path.join(temp, 'whole-isolated-database.dump');
  const admin = new Pool({ connectionString, max: 2 });
  const created = [];
  const pools = [];
  const open = db => {
    const pool = new Pool({ connectionString: urlFor(db), max: 3 });
    pools.push(pool);
    return pool;
  };
  try {
    for (const db of [sourceDb, candidateDb, rollbackDb]) {
      // These databases have random fixture-only names; never touch ordinary
      // EI production tables or replace a nonempty operator-owned DB.
      await admin.query('CREATE DATABASE "' + db + '"');
      created.push(db);
    }
    const sourcePool = open(sourceDb);
    const source = scoped(sourcePool, 'tenant-a');
    const other = scoped(sourcePool, 'tenant-b');
    await Promise.all([source.init(), other.init()]);
    await source.putTrigger(trigger());
    await other.putTrigger(trigger());
    const actor = { type: 'system', principal_id: 'restore-fixture' };
    await source.setTriggerState(trigger().triggerId, '1', 'paused', actor,
      { owner: ownerA });
    await other.setTriggerState(trigger().triggerId, '1', 'active', actor,
      { owner: ownerB });
    for (const scopedStore of [source, other]) {
      await scopedStore.appendAudit({
        auditId: 'source-audit', traceId: 'restore', timestamp: stamp,
        kind: 'trigger.created', entityType: 'trigger',
        entityId: trigger().triggerId, details: { bounded: true },
      });
    }
    await source.ensureWakeDelivery({
      wakeId: 'snapshot-wake', matchId: 'snapshot-match',
      triggerId: trigger().triggerId, triggerVersion: '1',
      runtime: 'test-host', now: stamp,
    });
    const claim = await source.claimWakeDelivery('snapshot-wake', {
      workerId: 'original-worker', now: stamp, leaseMs: 1000,
    });
    assert.ok(claim);
    await source.completeWakeDelivery('snapshot-wake', {
      workerId: 'original-worker', attemptCount: claim.attemptCount,
      runtimeReceiptId: 'host-idempotent-effect-1', now: stamp,
    });
    const expectedGap = await source.putMcpClientState({
      connectionId, serverId: 'upstream',
      eventName: 'invoice.failed',
      arguments: { source: { country: 'IT', zone: 'eu' } },
      deliveryMode: 'poll', cursor: 'opaque-provider-cursor',
      truncated: true,
    });
    assert.equal(expectedGap.gapUnresolved, true);
    await source.beginMcpConnectionAuthority({ connectionId, epoch });
    const accepted = await source.appendMcpOccurrence('provider',
      occurrence('durable-source-event'), 'sub', { connectionId, epoch });
    assert.equal(accepted.accepted, true);
    await source.revokeMcpConnectionAuthority({ connectionId, epoch });
    const expectedCheckpoint = await source.getMcpOccurrenceArchiveCheckpoint();
    assert.equal(expectedCheckpoint.endSequence, 1);
    assert.equal(await source.verifyAudit(), true);

    // Full-database clone is meaningful only after stopping ALL EI writers.
    await sourcePool.end();
    pools.splice(pools.indexOf(sourcePool), 1);
    await pgCli('pg_dump', [
      '--format=custom', '--no-owner', '--no-privileges', '--file', archive,
      // Intentionally NO --table filters: catalog, counters, sequences,
      // source dedup, audit, receipt and both tenants are in the archive.
    ], sourceDb);
    const bytes = await readFile(archive);
    assert.ok((await stat(archive)).size > 1024);
    const archiveHash = createHash('sha256').update(bytes).digest('hex');
    assert.match(archiveHash, /^[0-9a-f]{64}$/);
    const listing = (await pgCli('pg_restore', ['--list', archive], sourceDb)).stdout;
    for (const kind of ['metadata', 'records', 'history', 'leases', 'counters']) {
      assert.ok(listing.includes(prefix + '_' + kind),
        'full snapshot omitted ' + kind);
    }
    assert.ok(listing.includes(prefix + '_history_history_id_seq'));

    const restore = db => pgCli('pg_restore', [
      '--exit-on-error', '--single-transaction', '--no-owner',
      '--no-privileges', '--dbname', db, archive,
    ], db);
    await restore(candidateDb);
    const candidatePool = open(candidateDb);
    await assertRestored(candidatePool, expectedGap, expectedCheckpoint);

    // An incompatible signature MUST refuse a *cold* startup without
    // adopting, resetting or losing the preserved receipt/tenant evidence.
    await candidatePool.query('UPDATE "' + prefix +
      '_metadata" SET version=999 WHERE component=$1',
      [PATTERN_V2_SIGNATURE_COMPONENT]);
    await assert.rejects(scoped(candidatePool, 'tenant-a').init(),
      error => error?.code === 'EVENT_INTELLIGENCE_PATTERN_V2_SIGNATURE_INCOMPATIBLE');
    const intact = await candidatePool.query(
      'SELECT payload FROM "' + prefix +
      '_records" WHERE scope_id=$1 AND kind=$2 AND record_key=$3',
      ['tenant-a', 'wake_delivery', 'snapshot-wake']);
    assert.equal(intact.rows[0]?.payload?.runtimeReceiptId, 'host-idempotent-effect-1');

    // Abort cutover. Restore the SAME immutable backup to an independent
    // clean rollback database, never reinterpreting the broken candidate.
    assert.equal(createHash('sha256').update(await readFile(archive))
      .digest('hex'), archiveHash, 'rollback must use the original archive');
    await restore(rollbackDb);
    const rollbackPool = open(rollbackDb);
    await assertRestored(rollbackPool, expectedGap, expectedCheckpoint);

    // Original quiesced database remains intact and independently bootable.
    const sourceReopened = open(sourceDb);
    await assertRestored(sourceReopened, expectedGap, expectedCheckpoint);
  } finally {
    // Database drop is limited to the three unique databases created here.
    // No FORCE disconnect, no production/schema name provided by the user.
    await Promise.allSettled(pools.map(pool => pool.end()));
    try {
      for (const db of [...created].reverse()) {
        await admin.query('DROP DATABASE IF EXISTS "' + db + '"');
      }
    } finally {
      await admin.end();
      await rm(temp, { recursive: true, force: true });
    }
  }
});
