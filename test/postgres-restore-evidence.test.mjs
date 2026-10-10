import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { WakeRetryScheduler } from '../scripts/lib/wake-retry-scheduler.mjs';

const url = process.env.POSTGRES_URL;
const integrationTest = url ? test : test.skip;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const base = ('ei_dr_' + process.pid + '_' + Date.now()).slice(0, 38);
const sourcePrefix = base + '_s';
const restoredPrefix = base + '_r';
const tables = Object.freeze({
  records: ['scope_id', 'kind', 'record_key', 'payload', 'updated_at'],
  history: ['history_id', 'scope_id', 'kind', 'record_key', 'payload', 'created_at'],
  leases: ['scope_id', 'lease_kind', 'lease_key', 'owner_id', 'lease_until', 'updated_at'],
  counters: ['scope_id', 'name', 'value'],
  metadata: ['component', 'version', 'adopted_from', 'created_at'],
});
const iso = '2026-10-09T12:00:00.000Z';
function store(pool, tablePrefix, scopeId = 'tenant-A') {
  return new PostgresEventStore({ pool, tablePrefix, scopeId });
}
function definition(id) {
  return {
    protocolVersion: '0.2.0', schemaVersion: 'trigger.v0.2',
    triggerId: id, version: '1', conditionOnly: false,
    clauses: [{ id: 'event', event: 'dr.changed', arguments: {}, where: [] }],
    pattern: { version: '2', root: { kind: 'event', ref: 'event' } },
    withinMs: 60000,
    lifecycle: { oneShot: false, cooldownMs: 0, completeOnGoal: false },
    target: { runtime: 'restore-test', kind: 'task', id: 'task-1' },
    continuation: {
      instruction: 'Resume after restore',
      contextPolicy: { evidence: 'refs_only', maxEvents: 10, includeData: false },
    },
  };
}
function match(triggerId, matchId) {
  return {
    protocolVersion: '0.2.0', schemaVersion: 'trigger.v0.2',
    triggerId, triggerVersion: '1', matchId, status: 'matched',
    partitionKey: null, openedAt: iso, updatedAt: iso,
    expiresAt: '2026-10-09T12:01:00.000Z', sourceEvents: [],
    semanticDecision: null,
    patternState: {
      version: '2', role: 'match',
      signature: matchId, semanticDecisions: [],
    },
    firedWakeId: null, derivedEventIds: [],
  };
}
function table(prefix, suffix) {
  return '"' + prefix + '_' + suffix + '"';
}
async function cleanup(pool) {
  for (const suffix of Object.keys(tables)) {
    for (const prefix of [restoredPrefix, sourcePrefix]) {
      await pool.query('DROP TABLE IF EXISTS ' + table(prefix,suffix) + ' CASCADE');
    }
  }
}
/**
 * Test-only equivalent of an operator's consistent snapshot/restore.
 * Do not use as a production backup utility; pg_dump/pg_restore and
 * verified off-host snapshots are the recommended operator mechanisms.
 */
async function cloneInTransaction(pool, { abortAfter } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    for (const [suffix, columns] of Object.entries(tables)) {
      const names = columns.join(', ');
      await client.query(
        'DELETE FROM ' + table(restoredPrefix,suffix),
      );
      await client.query(
        'INSERT INTO ' + table(restoredPrefix,suffix) +
          ' (' + names + ') SELECT ' + names +
          ' FROM ' + table(sourcePrefix,suffix),
      );
      if (abortAfter === suffix) throw new Error('injected snapshot restore failure');
    }
    // A physical history restore must advance BIGSERIAL so future audit and
    // match revisions cannot collide with restored IDs.
    const seq = await client.query(
      'SELECT pg_get_serial_sequence($1, $2) AS name',
      [restoredPrefix + '_history', 'history_id'],
    );
    assert.ok(seq.rows[0]?.name);
    await client.query(
      'SELECT setval($1::regclass, (SELECT max(history_id) FROM ' +
        table(restoredPrefix,'history') + '), true)',
      [seq.rows[0].name],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

integrationTest('PostgreSQL restart/restore keeps tenant, wake, audit and history, with atomic failed restore', async () => {
  const pool = new Pool({ connectionString: url, max: 8 });
  try {
    const sourceA = store(pool, sourcePrefix);
    const sourceB = store(pool, sourcePrefix, 'tenant-B');
    const restoreA = store(pool, restoredPrefix);
    const restoreB = store(pool, restoredPrefix, 'tenant-B');
    await Promise.all([
      sourceA.init(), sourceB.init(), restoreA.init(), restoreB.init(),
    ]);
    await Promise.all([
      sourceA.putTrigger(definition('shared-trigger')),
      sourceB.putTrigger(definition('shared-trigger')),
    ]);
    // Create the delivery through the production coordinator. Its wake ID
    // must be deterministic from the actual match/target identity; synthetic
    // wake IDs would not prove protection against post-restore redispatch.
    await sourceA.setTriggerState(
      'shared-trigger','1','active',
      { type:'system', principal_id:'restore-test' },
      { owner:{type:'user',principal_id:'alice',tenant_id:'tenant-A'} },
    );
    const sourceMatch = await sourceA.appendTriggerMatch(
      match('shared-trigger','match-1'),
    );
    let originalDeliveries = 0;
    const sourceCoordinator = new CompositeWakeCoordinator({
      store: sourceA,
      triggerEngine: new CompositeTriggerEngine(sourceA),
      workerId: 'source-worker',
      now: () => new Date(iso),
      deliverer: async () => {
        originalDeliveries++;
        return { runtimeReceiptId: 'receipt-original' };
      },
    });
    const delivered = await sourceCoordinator.deliverMatched(sourceMatch);
    assert.equal(delivered.status, 'wake_delivered');
    assert.equal(originalDeliveries, 1);
    const wakeId = delivered.wake.wakeId;
    assert.match(wakeId, /^wake_/);
    await sourceA.setTriggerState(
      'shared-trigger','1','paused',
      { type:'system', principal_id:'restore-test' },
    );
    await sourceA.appendAudit({
      auditId:'dr-audit-1',traceId:'trace-1',timestamp:iso,
      kind:'trigger.created',entityType:'trigger',
      entityId:'shared-trigger',details:{source:'snapshot'},
    });
    await sourceA.appendAudit({
      auditId:'dr-audit-2',traceId:'trace-2',timestamp:iso,
      kind:'trigger.paused',entityType:'trigger',
      entityId:'shared-trigger',details:{source:'snapshot'},
    });
    assert.equal(await sourceA.verifyAudit(),true);
    const srcCounts = await sourceA.restoredCounts();
    const srcAudit = await sourceA.listAudit();
    const srcHistory = await sourceA.listTriggerMatchHistory('match-1');

    // An interrupted target restore must roll back all partial row copies,
    // leaving only the target's clean schema v1 bootstrap marker.
    await assert.rejects(
      () => cloneInTransaction(pool,{abortAfter:'history'}),
      /injected snapshot restore failure/,
    );
    assert.deepEqual(await restoreA.listTriggers(),[]);
    assert.deepEqual(await restoreA.listAudit(),[]);
    assert.equal((await pool.query(
      'SELECT version FROM ' + table(restoredPrefix,'metadata') +
      " WHERE component='store'",
    )).rows[0].version,1);

    await cloneInTransaction(pool);
    const reopenedA = store(pool,restoredPrefix);
    const reopenedB = store(pool,restoredPrefix,'tenant-B');
    await Promise.all([reopenedA.init(),reopenedB.init()]);
    assert.deepEqual(await reopenedA.restoredCounts(),srcCounts);
    assert.deepEqual(await reopenedA.listAudit(),srcAudit);
    assert.equal(await reopenedA.verifyAudit(),true);
    assert.deepEqual(await reopenedA.listTriggerMatchHistory('match-1'),srcHistory);
    assert.equal((await reopenedA.getTriggerState('shared-trigger','1')).status,'paused');
    assert.equal((await reopenedA.getWakeDelivery(wakeId)).runtimeReceiptId,'receipt-original');
    assert.equal(await reopenedA.claimWakeDelivery(wakeId,{
      workerId:'restored-worker',
      now:'2026-10-09T13:00:00.000Z',leaseMs:1000,
    }),null);
    let restoredDeliveries = 0;
    const restoredCoordinator = new CompositeWakeCoordinator({
      store: reopenedA,
      triggerEngine: new CompositeTriggerEngine(reopenedA),
      workerId: 'restored-worker',
      now: () => new Date('2026-10-09T13:00:00.000Z'),
      deliverer: async () => {
        restoredDeliveries++;
        return { runtimeReceiptId: 'SHOULD-NOT-BE-CALLED' };
      },
    });
    const retry = new WakeRetryScheduler({
      store: reopenedA,
      now: () => new Date('2026-10-09T13:00:00.000Z'),
      resolveCoordinator: () => restoredCoordinator,
    });
    assert.deepEqual(await retry.runDue(), []);
    const restoredMatch = (await reopenedA.listTriggerMatches('shared-trigger'))
      .find((row) => row.matchId === 'match-1');
    assert.equal(restoredMatch.status, 'fired');
    const replay = await restoredCoordinator.deliverMatched(restoredMatch);
    assert.equal(replay.status, 'already_fired');
    assert.equal(restoredDeliveries, 0);
    assert.equal((await reopenedB.listTriggers()).length,1);
    assert.equal((await reopenedB.listAudit()).length,0);
    assert.equal((await reopenedB.getWakeDelivery(wakeId)),null);

    await reopenedA.appendAudit({
      auditId:'dr-audit-post-restore',traceId:'trace-3',
      timestamp:'2026-10-09T13:00:00.000Z',
      kind:'trigger.resumed',entityType:'trigger',
      entityId:'shared-trigger',details:{phase:'after-restore'},
    });
    await reopenedA.appendTriggerMatch({
      ...match('shared-trigger','match-1'),
      updatedAt:'2026-10-09T13:00:00.000Z',
    });
    assert.equal((await reopenedA.listAudit()).length,srcAudit.length+1);
    assert.equal(await reopenedA.verifyAudit(),true);
    assert.equal((await reopenedA.listTriggerMatchHistory('match-1')).length,srcHistory.length+1);
    const sequence = await pool.query(
      'SELECT max(history_id)::bigint AS max FROM ' + table(restoredPrefix,'history'),
    );
    assert.ok(Number(sequence.rows[0].max) > srcCounts.audit);
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});
