import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';

const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integrationTest = url ? test : test.skip;
const timestamp = '2026-10-18T11:00:00.000Z';

function trigger() {
  return {
    triggerId: 'preclaim-crash-trigger',
    version: '1',
    conditionOnly: false,
    clauses: [{
      id: 'a', event: 'invoice.submitted', arguments: {}, where: [],
    }],
    pattern: { version: '2', root: { kind: 'event', ref: 'a' } },
    withinMs: 60000,
    target: { runtime: 'host-fixture', kind: 'task', id: 'host-turn-1' },
    continuation: { instruction: 'Resume the host-owned task.' },
  };
}
function persistedMatch() {
  return {
    protocolVersion: '0.2.0',
    schemaVersion: 'trigger.v0.2',
    matchId: 'durable-preclaim-match',
    triggerId: 'preclaim-crash-trigger',
    triggerVersion: '1',
    status: 'matched',
    partitionKey: null,
    openedAt: timestamp,
    expiresAt: '2026-10-18T11:01:00.000Z',
    updatedAt: timestamp,
    sourceEvents: [],
    semanticDecision: null,
    patternState: {
      version: '2',
      role: 'match',
      signature: 'durable-preclaim-match',
      semanticDecisions: [],
    },
    firedWakeId: null,
    derivedEventIds: [],
  };
}

integrationTest('independent PG pools recover persisted match from worker loss BEFORE wake claim', async () => {
  const prefix = 'ei_preclaim_' + randomBytes(5).toString('hex');
  const scopeId = 'tenant-preclaim';
  let poolA = new Pool({ connectionString: url, max: 2 });
  let poolB;
  let poolC;
  let continueDelivery;
  try {
    const original = new PostgresEventStore({ pool: poolA, scopeId, tablePrefix: prefix });
    await original.init();
    await original.putTrigger(trigger());
    await original.appendTriggerMatch(persistedMatch());

    assert.equal((await original.listTriggerMatches('preclaim-crash-trigger')).length, 1);
    assert.deepEqual(await original.listDueWakeDeliveries(timestamp), [],
      'crash boundary must be after committed match and before any wake claim');

    // Tear down every physical connection from original worker before its
    // first delivery claim. This is pool/worker disappearance, not SIGKILL.
    await poolA.end();
    poolA = null;

    poolB = new Pool({ connectionString: url, max: 2 });
    poolC = new Pool({ connectionString: url, max: 2 });
    const left = new PostgresEventStore({ pool: poolB, scopeId, tablePrefix: prefix });
    const right = new PostgresEventStore({ pool: poolC, scopeId, tablePrefix: prefix });
    await Promise.all([left.init(), right.init()]);

    const recovered = (await left.listTriggerMatches('preclaim-crash-trigger'))
      .find(record => record.matchId === 'durable-preclaim-match');
    assert.equal(recovered?.status, 'matched');

    let firstDeliveryStarted;
    const started = new Promise(resolve => { firstDeliveryStarted = resolve; });
    const hold = new Promise(resolve => { continueDelivery = resolve; });
    let hostEffects = 0;
    const deliverer = async () => {
      hostEffects += 1;
      firstDeliveryStarted();
      await hold;
      return { runtimeReceiptId: 'host-durable-receipt-preclaim' };
    };
    const coordinatorB = new CompositeWakeCoordinator({
      store: left, triggerEngine: new CompositeTriggerEngine(left),
      workerId: 'post-crash-worker-b', deliverer,
    });
    const coordinatorC = new CompositeWakeCoordinator({
      store: right, triggerEngine: new CompositeTriggerEngine(right),
      workerId: 'post-crash-worker-c', deliverer,
    });

    const firstRun = coordinatorB.deliverMatched(recovered);
    await started;
    const peerRecord = (await right.listTriggerMatches('preclaim-crash-trigger'))
      .find(record => record.matchId === 'durable-preclaim-match');
    const loser = await coordinatorC.deliverMatched(peerRecord);
    assert.equal(loser.status, 'delivery_in_progress',
      'other physical pool may not duplicate the claimed host continuation');
    assert.equal(hostEffects, 1);

    continueDelivery();
    const winner = await firstRun;
    assert.equal(winner.status, 'wake_delivered');
    assert.equal(hostEffects, 1);

    const delivery = await right.getWakeDelivery(winner.wake.wakeId);
    assert.equal(delivery.status, 'delivered');
    assert.equal(delivery.attemptCount, 1);
    assert.equal(delivery.runtimeReceiptId, 'host-durable-receipt-preclaim');

    const persisted = (await right.listTriggerMatches('preclaim-crash-trigger'))
      .find(record => record.matchId === 'durable-preclaim-match');
    assert.equal(persisted.status, 'fired');
    const replay = await coordinatorC.deliverMatched(persisted);
    assert.equal(replay.status, 'already_fired');
    assert.equal(hostEffects, 1);
    assert.equal(await right.claimWakeDelivery(winner.wake.wakeId, {
      workerId: 'late-worker', now: '2026-10-18T11:05:00.000Z',
    }), null);
  } finally {
    continueDelivery?.();
    const cleanup = poolC ?? poolB ?? new Pool({ connectionString: url, max: 2 });
    try {
      for (const suffix of ['metadata', 'leases', 'history', 'records', 'counters']) {
        await cleanup.query('DROP TABLE IF EXISTS "' + prefix + '_' + suffix + '" CASCADE');
      }
    } finally {
      await Promise.all([poolA, poolB, poolC, cleanup]
        .filter(Boolean).filter((pool, index, all) => all.indexOf(pool) === index)
        .map(pool => pool.end()));
    }
  }
});
