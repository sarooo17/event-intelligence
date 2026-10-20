import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { TriggerControlPlane } from '../scripts/lib/trigger-control-plane.mjs';

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
      pool: sourcePool, dispatchPoolIdentity: sourcePool, tablePrefix, scopeId: 'tenant-logical',
    });
    await source.init();
    await source.putTrigger(definition());
    const alice = { type: 'user', principal_id: 'alice', tenant_id: 'tenant-logical' };
    const bob = { type: 'user', principal_id: 'bob', tenant_id: 'tenant-logical' };
    await source.setTriggerState(
      'logical-restore-trigger', '1', 'paused',
      { type: 'system', principal_id: 'recovery-fixture' },
      { owner: alice },
    );
    const sourceControl = new TriggerControlPlane({ store: source });
    assert.equal((await sourceControl.listTriggers({ owner: alice })).length, 1);
    assert.deepEqual(await sourceControl.listTriggers({ owner: bob }), [],
      'same-scope foreign owner must not inspect before snapshot');
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
    // A logical backup must include MCP delivery completeness/cursors as
    // well as wake receipts. Losing an unresolved gap would make restored
    // negative CEP incorrectly claim that a forbidden event is absent.
    const mcpIdentity = {
      environment:'production',
      source:{region:{country:'IT',zone:'eu'},tags:['invoices','closed']},
    };
    // Simulate reconstruction in an independent recovered worker: source
    // identity key order differs at the outer and nested object levels.
    const restoredLookup = {
      source:{tags:['invoices','closed'],region:{zone:'eu',country:'IT'}},
      environment:'production',
    };
    const unresolvedGap = await source.putMcpClientState({
      connectionId:'restore-mcp-connection', serverId:'upstream',
      eventName:'restore.failed', arguments:mcpIdentity,
      deliveryMode:'poll', cursor:'opaque-cursor-before-restore',
      truncated:true,
    });
    assert.equal(unresolvedGap.gapUnresolved,true);
    // Same connection + event but DIFFERENT deeply nested arguments must
    // occupy a distinct persisted source key and independent revision chain.
    // Without this negative aliasing control the reordered lookup above
    // could pass even if the store ignored source arguments completely.
    const alternateIdentity = {
      source:{region:{country:'FR',zone:'eu'},tags:['invoices','closed']},
      environment:'production',
    };
    const alternateState = await source.putMcpClientState({
      connectionId:'restore-mcp-connection',serverId:'upstream',
      eventName:'restore.failed',arguments:alternateIdentity,
      deliveryMode:'poll',cursor:'other-source-independent-cursor',
      truncated:false,
    });
    assert.equal(alternateState.gapUnresolved,false);
    assert.equal((await source.listMcpClientStates('restore-mcp-connection')).length,2);
    assert.deepEqual(await source.getMcpClientState(
      'restore-mcp-connection','restore.failed',mcpIdentity),unresolvedGap);
    const originalGapSnapshot = (await source.getMcpGapStateAndSnapshot()).snapshot;
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
      pool: targetPool, dispatchPoolIdentity: targetPool, tablePrefix, scopeId: 'tenant-logical',
    });
    await target.init();
    const restoredGap = await target.getMcpClientState(
      'restore-mcp-connection','restore.failed',restoredLookup);
    assert.deepEqual(restoredGap,unresolvedGap,
      'pg_dump/pg_restore must preserve exact MCP cursor and gap generation');
    assert.equal(restoredGap.cursor,'opaque-cursor-before-restore');
    assert.equal(restoredGap.gapUnresolved,true);
    assert.equal(restoredGap.completenessRevision,unresolvedGap.completenessRevision);
    const differentLookup = {
      environment:'production',
      source:{tags:['invoices','closed'],region:{zone:'eu',country:'FR'}},
    };
    assert.deepEqual(await target.getMcpClientState(
      'restore-mcp-connection','restore.failed',differentLookup),alternateState,
      'nested alternate identity keeps independent cursor and revision after restore');
    assert.equal((await target.listMcpClientStates('restore-mcp-connection')).length,2,
      'restoration must not collapse distinct source-argument identities');
    assert.equal((await target.getMcpGapStateAndSnapshot()).snapshot,
      originalGapSnapshot,
      'restored CEP must retain the unresolved delivery-gap finality fence');
    assert.equal(await target.forScope('other-tenant').then(scope=>
      scope.getMcpClientState('restore-mcp-connection','restore.failed',restoredLookup)
    ),null,'cross-tenant restoration must not expose a source cursor');

    // A host receipt covering a pre-backup gap must not erase a *new* gap
    // recorded by the restored worker: durable source revision is fenced.
    const subsequentGap = await target.putMcpClientState({
      ...restoredGap,arguments:restoredLookup,
      cursor:'opaque-cursor-after-restore',truncated:true,
    });
    assert.equal(subsequentGap.gapUnresolved,true);
    assert.equal(subsequentGap.completenessRevision,
      unresolvedGap.completenessRevision+1);
    const newerSnapshot = (await target.getMcpGapStateAndSnapshot()).snapshot;
    await assert.rejects(target.putMcpClientState({
      ...restoredGap,arguments:restoredLookup,
      truncated:false,gapReconciled:true,
      reconciliationEvidenceId:'stale-pre-backup-replay',
      expectedCompletenessRevision:unresolvedGap.completenessRevision,
    }),error=>error?.code==='MCP_EVENTS_GAP_REVISION_CONFLICT',
    'old host replay evidence must not erase a newer recovered gap');
    assert.deepEqual(await target.getMcpClientState(
      'restore-mcp-connection','restore.failed',restoredLookup),subsequentGap);
    assert.equal((await target.getMcpGapStateAndSnapshot()).snapshot,newerSnapshot,
      'stale receipt must not change negative CEP finality evidence');
    const reconciledGap = await target.putMcpClientState({
      ...subsequentGap,arguments:restoredLookup,
      truncated:false,gapReconciled:true,
      expectedCompletenessRevision:subsequentGap.completenessRevision,
      reconciliationEvidenceId:'verified-after-backup-and-replay',
    });
    assert.equal(reconciledGap.gapUnresolved,false);
    assert.equal(reconciledGap.completenessRevision,
      subsequentGap.completenessRevision+1);
    assert.deepEqual(await target.getMcpClientState(
      'restore-mcp-connection','restore.failed',differentLookup),alternateState,
      'repairing the first restored source must never update a second identity');
    assert.notEqual((await target.getMcpGapStateAndSnapshot()).snapshot,
      newerSnapshot);
    assert.deepEqual(await target.listTriggers(), originalDefinitions);
    const restoredState = await target.getTriggerState('logical-restore-trigger', '1');
    assert.equal(restoredState.status, 'paused');
    assert.deepEqual(restoredState.owner, alice,
      'owner identity must be preserved by pg_dump/pg_restore');
    const restoredControl = new TriggerControlPlane({ store: target });
    assert.equal((await restoredControl.listTriggers({ owner: alice })).length, 1);
    assert.deepEqual(await restoredControl.listTriggers({ owner: bob }), [],
      'foreign owner in the SAME tenant must not see restored trigger');
    assert.deepEqual(await restoredControl.listTriggers({
      owner: { ...alice, tenant_id: 'other-tenant' },
    }), [], 'cross-tenant owner identity must not match');
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
