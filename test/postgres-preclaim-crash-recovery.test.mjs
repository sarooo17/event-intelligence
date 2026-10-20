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
  let poolA = new Pool({ connectionString: url, max: 2, query_timeout: 3000, connectionTimeoutMillis: 3000, statement_timeout: 3000 });
  let poolB;
  let poolC;
  let continueDelivery;
  let firstRun;
  try {
    const original = new PostgresEventStore({ pool: poolA, dispatchPoolIdentity: poolA, scopeId, tablePrefix: prefix });
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
    const left = new PostgresEventStore({ pool: poolB, dispatchPoolIdentity: poolB, scopeId, tablePrefix: prefix });
    const right = new PostgresEventStore({ pool: poolC, dispatchPoolIdentity: poolC, scopeId, tablePrefix: prefix });
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
      if (hostEffects !== 1) {
        throw new Error('duplicate external host effect: competing wake claimant');
      }
      firstDeliveryStarted();
      await hold;
      return { runtimeReceiptId: 'host-durable-receipt-preclaim' };
    };
    const coordinatorB = new CompositeWakeCoordinator({
      store: left, triggerEngine: new CompositeTriggerEngine(left),
      workerId: 'post-crash-worker-b', leaseMs: 120000, deliverer,
    });
    const coordinatorC = new CompositeWakeCoordinator({
      store: right, triggerEngine: new CompositeTriggerEngine(right),
      workerId: 'post-crash-worker-c', leaseMs: 120000, deliverer,
    });

    firstRun = coordinatorB.deliverMatched(recovered);
    // Distinguish a failed/preempted claim from a slow deliverer immediately.
    // The original test waited forever if no deliverer invocation occurred.
    await Promise.race([
      started,
      firstRun.then(
        result => { throw new Error('winner settled before reaching host delivery: ' + result.status); },
        error => { throw error; },
      ),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('winner did not enter host deliverer within 5 seconds')),
          5000,
        );
        timer.unref?.();
      }),
    ]);
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
    // Settle the original winner before dropping live PostgreSQL tables.
    // Prevent orphan writes/unhandled rejections from masking a failed
    // arbitration assertion above.
    if (firstRun) {
      await Promise.race([
        Promise.allSettled([firstRun]),
        new Promise(resolve => {
          const timer = setTimeout(resolve, 7000);
          timer.unref?.();
        }),
      ]);
    }
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
