import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';
import { EventProcessor } from '../scripts/lib/event-processor.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { WakeRetryScheduler } from '../scripts/lib/wake-retry-scheduler.mjs';

async function matchedTrigger(store, engine, triggerId = 'retry-trigger') {
  await engine.register({
    triggerId,
    version: '1',
    clauses: [{
      id: 'event',
      event: 'build.completed',
      where: [],
    }],
    expression: { kind: 'anyOf', refs: ['event'] },
    withinMs: 60000,
    target: {
      runtime: 'runtime-probe',
      kind: 'task',
      id: 'retry-task',
    },
  });

  const result = await engine.ingest({
    traceId: 'trace-1',
    sourceEventId: 'event-1',
    name: 'build.completed',
    occurredAt: '2026-09-20T14:00:00.000Z',
    serverId: 'test-server',
    provider: 'test',
    data: {},
  });
  assert.equal(result[0].match.status, 'matched');
  return result[0].match;
}

test('failed wake persists retry state and succeeds after store/runtime restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-wake-retry-'));
  const firstNow = new Date('2026-09-20T14:00:01.000Z');

  try {
    const firstStore = new PersistentEventStore(dir);
    await firstStore.init();
    const firstEngine = new CompositeTriggerEngine(
      firstStore,
      null,
      () => firstNow,
    );
    const match = await matchedTrigger(firstStore, firstEngine);

    const firstCoordinator = new CompositeWakeCoordinator({
      store: firstStore,
      triggerEngine: firstEngine,
      now: () => firstNow,
      workerId: 'worker-before-restart',
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 1000,
      maxAttempts: 3,
      deliverer: async () => {
        throw new Error('runtime temporarily unavailable');
      },
    });

    const firstAttempt = await firstCoordinator.deliverMatched(match);
    assert.equal(firstAttempt.status, 'retry_scheduled');
    assert.equal(
      firstStore.getWakeDelivery(firstAttempt.wake.wakeId).status,
      'retry_pending',
    );
    assert.equal(
      firstStore.getWakeDelivery(firstAttempt.wake.wakeId).attemptCount,
      1,
    );
    assert.equal(firstStore.latestWake(firstAttempt.wake.wakeId).status, 'queued');

    const secondNow = new Date('2026-09-20T14:00:02.100Z');
    const restoredStore = new PersistentEventStore(dir);
    const restoredCounts = await restoredStore.init();
    assert.equal(restoredCounts.wakeDeliveries, 1);

    const restoredEngine = new CompositeTriggerEngine(
      restoredStore,
      null,
      () => secondNow,
    );
    let deliveries = 0;
    const restoredCoordinator = new CompositeWakeCoordinator({
      store: restoredStore,
      triggerEngine: restoredEngine,
      now: () => secondNow,
      workerId: 'worker-after-restart',
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 1000,
      maxAttempts: 3,
      deliverer: async (packet) => {
        deliveries += 1;
        return {
          runtimeReceiptId: `receipt:${packet.wake_id}`,
        };
      },
    });
    const scheduler = new WakeRetryScheduler({
      store: restoredStore,
      now: () => secondNow,
      resolveCoordinator: (runtime) =>
        runtime === 'runtime-probe' ? restoredCoordinator : null,
    });

    const outcomes = await scheduler.runDue();
    assert.deepEqual(
      outcomes.map((entry) => entry.status),
      ['wake_delivered'],
    );
    assert.equal(deliveries, 1);

    const delivery = restoredStore.getWakeDelivery(firstAttempt.wake.wakeId);
    assert.equal(delivery.status, 'delivered');
    assert.equal(delivery.attemptCount, 2);
    assert.match(delivery.runtimeReceiptId, /^receipt:/);

    const fired = restoredStore.listTriggerMatches('retry-trigger')[0];
    assert.equal(fired.status, 'fired');
    assert.equal(fired.firedWakeId, firstAttempt.wake.wakeId);
    assert.equal(await restoredStore.verifyAudit(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lease claim prevents two workers from delivering the same wake concurrently', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-wake-claim-'));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let deliveries = 0;
  let store = null;
  let firstRun = null;
  const now = new Date('2026-09-20T15:00:00.000Z');

  try {
    store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store, null, () => now);
    const match = await matchedTrigger(store, engine, 'claim-trigger');

    const deliverer = async (packet) => {
      deliveries += 1;
      await gate;
      return { runtimeReceiptId: `receipt:${packet.wake_id}` };
    };

    const first = new CompositeWakeCoordinator({
      store,
      triggerEngine: engine,
      now: () => now,
      workerId: 'worker-a',
      deliverer,
    });
    const second = new CompositeWakeCoordinator({
      store,
      triggerEngine: engine,
      now: () => now,
      workerId: 'worker-b',
      deliverer,
    });

    firstRun = first.deliverMatched(match);
    for (let attempt = 0; attempt < 100 && deliveries === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(deliveries, 1);

    const secondRun = await second.deliverMatched(match);

    assert.equal(deliveries, 1);
    assert.equal(secondRun.status, 'delivery_in_progress');

    release();
    const completed = await firstRun;
    assert.equal(completed.status, 'wake_delivered');
    assert.equal(deliveries, 1);
    assert.equal(
      store.getWakeDelivery(completed.wake.wakeId).status,
      'delivered',
    );
  } finally {
    release?.();
    if (firstRun) {
      await Promise.allSettled([firstRun]);
    }
    await store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('wake reaches dead-letter only after configured retry budget is exhausted', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-wake-dlq-'));
  let now = new Date('2026-09-20T16:00:00.000Z');

  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store, null, () => now);
    const match = await matchedTrigger(store, engine, 'dead-letter-trigger');
    const coordinator = new CompositeWakeCoordinator({
      store,
      triggerEngine: engine,
      now: () => now,
      workerId: 'worker-dlq',
      maxAttempts: 2,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 1000,
      deliverer: async () => {
        throw new Error('permanent failure');
      },
    });

    const first = await coordinator.deliverMatched(match);
    assert.equal(first.status, 'retry_scheduled');
    assert.equal(store.getWakeDelivery(first.wake.wakeId).attemptCount, 1);

    now = new Date(now.getTime() + 1100);
    const second = await coordinator.deliverMatched(match);
    assert.equal(second.status, 'dead_letter');
    assert.equal(store.getWakeDelivery(second.wake.wakeId).attemptCount, 2);
    assert.equal(store.getWakeDelivery(second.wake.wakeId).status, 'dead_letter');
    assert.equal(store.listDueWakeDeliveries(new Date(now.getTime() + 60000).toISOString()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('direct event wake uses the same durable retry model across restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-direct-wake-retry-'));
  const firstNow = new Date('2026-09-20T17:00:00.000Z');
  const input = {
    event: {
      eventId: 'direct-event-1',
      name: 'provider.alert',
      timestamp: '2026-09-20T16:59:59.000Z',
      data: { severity: 'high' },
      cursor: null,
    },
    context: {
      environmentId: 'env-test',
      subscriptionId: 'sub-test',
      serverId: 'provider-test',
      transport: 'poll',
      provider: 'test',
      target: {
        runtime: 'runtime-probe',
        kind: 'task',
        id: 'direct-task',
      },
    },
  };

  try {
    const firstStore = new PersistentEventStore(dir);
    await firstStore.init();
    const firstProcessor = new EventProcessor({
      store: firstStore,
      now: () => firstNow,
      workerId: 'direct-worker-1',
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 1000,
      maxAttempts: 3,
      wakeDeliverer: async () => {
        throw new Error('runtime offline');
      },
    });

    const first = await firstProcessor.ingest(input);
    assert.equal(first.status, 'retry_scheduled');
    assert.equal(firstStore.getWakeDelivery(first.wake.wakeId).sourceType, 'event');
    assert.equal(firstStore.getWakeDelivery(first.wake.wakeId).attemptCount, 1);

    const secondNow = new Date(firstNow.getTime() + 1100);
    const restoredStore = new PersistentEventStore(dir);
    await restoredStore.init();
    let delivered = 0;
    const restoredProcessor = new EventProcessor({
      store: restoredStore,
      now: () => secondNow,
      workerId: 'direct-worker-2',
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 1000,
      maxAttempts: 3,
      wakeDeliverer: async ({ wake }) => {
        delivered += 1;
        return { runtimeReceiptId: `receipt:${wake.wakeId}` };
      },
    });
    const scheduler = new WakeRetryScheduler({
      store: restoredStore,
      now: () => secondNow,
      eventProcessor: restoredProcessor,
      resolveCoordinator: () => null,
    });

    const outcomes = await scheduler.runDue();
    assert.deepEqual(outcomes.map((entry) => entry.status), ['wake_delivered']);
    assert.equal(delivered, 1);
    assert.equal(restoredStore.getWakeDelivery(first.wake.wakeId).status, 'delivered');
    assert.equal(restoredStore.latestWake(first.wake.wakeId).status, 'delivered');
    assert.equal(await restoredStore.verifyAudit(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('a persisted runtime receipt is reconciled after restart without redelivery', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-wake-reconcile-'));
  let now = new Date('2026-09-20T18:00:00.000Z');

  try {
    const firstStore = new PersistentEventStore(dir);
    await firstStore.init();
    const firstEngine = new CompositeTriggerEngine(firstStore, null, () => now);
    const match = await matchedTrigger(firstStore, firstEngine, 'reconcile-trigger');
    const failing = new CompositeWakeCoordinator({
      store: firstStore,
      triggerEngine: firstEngine,
      now: () => now,
      workerId: 'worker-initial',
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 1000,
      maxAttempts: 3,
      deliverer: async () => {
        throw new Error('first attempt fails');
      },
    });

    const first = await failing.deliverMatched(match);
    assert.equal(first.status, 'retry_scheduled');
    const wakeId = first.wake.wakeId;

    now = new Date(now.getTime() + 1100);
    const claim = await firstStore.claimWakeDelivery(wakeId, {
      workerId: 'worker-crashed-after-receipt',
      now: now.toISOString(),
      leaseMs: 30000,
    });
    assert.ok(claim);
    await firstStore.completeWakeDelivery(wakeId, {
      workerId: 'worker-crashed-after-receipt',
      runtimeReceiptId: 'receipt-already-returned',
      now: now.toISOString(),
    });

    assert.equal(firstStore.latestWake(wakeId).status, 'queued');
    assert.equal(firstStore.listTriggerMatches('reconcile-trigger')[0].status, 'matched');

    const restoredStore = new PersistentEventStore(dir);
    await restoredStore.init();
    const restoredEngine = new CompositeTriggerEngine(restoredStore, null, () => now);
    let redeliveries = 0;
    const restoredCoordinator = new CompositeWakeCoordinator({
      store: restoredStore,
      triggerEngine: restoredEngine,
      now: () => now,
      workerId: 'worker-reconciler',
      deliverer: async () => {
        redeliveries += 1;
        return { runtimeReceiptId: 'must-not-run' };
      },
    });
    const scheduler = new WakeRetryScheduler({
      store: restoredStore,
      now: () => now,
      resolveCoordinator: (runtime) =>
        runtime === 'runtime-probe' ? restoredCoordinator : null,
    });

    const outcomes = await scheduler.runDue();
    assert.deepEqual(outcomes.map((entry) => entry.status), ['wake_delivered']);
    assert.equal(redeliveries, 0);
    assert.equal(restoredStore.latestWake(wakeId).status, 'delivered');
    assert.equal(restoredStore.latestWake(wakeId).runtimeReceiptId, 'receipt-already-returned');
    assert.equal(restoredStore.listTriggerMatches('reconcile-trigger')[0].status, 'fired');
    assert.equal(await restoredStore.verifyAudit(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
