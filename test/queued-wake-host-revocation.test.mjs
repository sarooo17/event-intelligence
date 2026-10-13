import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { WakeRetryScheduler } from '../scripts/lib/wake-retry-scheduler.mjs';

async function matchOnce(store, engine) {
  await engine.register({
    triggerId: 'host-owned-policy-trigger',
    version: '1',
    clauses: [{ id: 'ev', event: 'source.revocable', where: [] }],
    pattern: { root: { kind: 'event', ref: 'ev' } },
    withinMs: 60000,
    target: {
      runtime: 'host-managed-runtime',
      kind: 'task',
      id: 'permissioned-effect',
    },
  });
  const results = await engine.ingest({
    traceId: 'host-revocation-trace',
    sourceEventId: 'source-before-revoke-1',
    name: 'source.revocable',
    occurredAt: '2026-10-13T10:00:00.000Z',
    serverId: 'same-mcp-connection-id',
    provider: 'host-authorized-mcp',
    data: {},
  });
  assert.equal(results[0].match.status, 'matched');
  return results[0].match;
}

function coordinator({ store, engine, at, workerId, deliverer, maxAttempts = 4 }) {
  return new CompositeWakeCoordinator({
    store,
    triggerEngine: engine,
    now: () => new Date(at),
    workerId,
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 1000,
    maxAttempts,
    deliverer,
  });
}

function scheduler({ store, engine, at, workerId, deliverer, maxAttempts }) {
  const instance = coordinator({
    store, engine, at, workerId, deliverer, maxAttempts,
  });
  return new WakeRetryScheduler({
    store,
    now: () => new Date(at),
    resolveCoordinator: runtime =>
      runtime === 'host-managed-runtime' ? instance : null,
  });
}

test('durable queued wake rechecks host-owned revocation before effect on retry and after restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-queued-host-revoke-'));
  let store;
  const policy = { authorized: true, checked: 0, effects: [] };
  const hostDispatcher = async packet => {
    // The host, not EI, checks current session/tenant/owner authority on
    // EVERY dispatch. Same MCP connection ID does not prove old authority.
    policy.checked++;
    if (!policy.authorized) throw new Error('host policy denied');
    policy.effects.push(packet.wake_id);
    return { runtimeReceiptId: 'host-receipt:' + packet.wake_id };
  };
  try {
    store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    const match = await matchOnce(store, engine);
    let firstCalls = 0;
    const initial = await coordinator({
      store,
      engine,
      at: '2026-10-13T10:00:01.000Z',
      workerId: 'before-host-revocation',
      deliverer: async () => {
        firstCalls++;
        throw new Error('temporary host dispatcher outage');
      },
    }).deliverMatched(match);
    assert.equal(initial.status, 'retry_scheduled');
    assert.equal(firstCalls, 1);
    const wakeId = initial.wake.wakeId;
    assert.equal(store.getWakeDelivery(wakeId).attemptCount, 1);
    assert.equal(store.getWakeDelivery(wakeId).status, 'retry_pending');
    assert.equal(store.getWakeDelivery(wakeId).runtimeReceiptId, null);
    assert.equal(policy.effects.length, 0);

    // The host revokes the session AFTER EI has durably matched and
    // queued this wake. No naive source disconnect can revoke its target.
    policy.authorized = false;
    await store.close();
    store = new PersistentEventStore(dir);
    await store.init();
    const restartedEngine = new CompositeTriggerEngine(store);
    const denied = scheduler({
      store,
      engine: restartedEngine,
      at: '2026-10-13T10:00:02.100Z',
      workerId: 'fresh-worker-after-revocation',
      deliverer: hostDispatcher,
      maxAttempts: 4,
    });
    const deniedResults = await denied.runDue();
    assert.deepEqual(deniedResults.map(row => row.status), ['retry_scheduled']);
    assert.equal(policy.checked, 1,
      'host gate must run again for an already-queued durable wake');
    assert.equal(policy.effects.length, 0,
      'a revoked session cannot cause host side effects');
    assert.equal(store.getWakeDelivery(wakeId).attemptCount, 2);
    assert.equal(store.getWakeDelivery(wakeId).status, 'retry_pending');
    assert.equal(store.getWakeDelivery(wakeId).runtimeReceiptId, null);
    assert.equal(store.latestWake(wakeId).status, 'queued');

    // A replacement authorized host session may later permit this same
    // target. Authorization must come from fresh host state, not the old
    // source connection ID or match evidence.
    policy.authorized = true;
    const approved = scheduler({
      store,
      engine: restartedEngine,
      at: '2026-10-13T10:00:03.200Z',
      workerId: 'fresh-worker-after-reauthorization',
      deliverer: hostDispatcher,
      maxAttempts: 4,
    });
    assert.deepEqual((await approved.runDue()).map(row => row.status),
      ['wake_delivered']);
    assert.equal(policy.checked, 2);
    assert.deepEqual(policy.effects, [wakeId]);
    const delivery = store.getWakeDelivery(wakeId);
    assert.equal(delivery.status, 'delivered');
    assert.equal(delivery.attemptCount, 3);
    assert.equal(delivery.runtimeReceiptId, 'host-receipt:' + wakeId);
    const finalMatch = store.listTriggerMatches('host-owned-policy-trigger')
      .find(row => row.matchId === match.matchId);
    assert.equal(finalMatch.status, 'fired');
    assert.equal(finalMatch.firedWakeId, wakeId);
    assert.deepEqual(await approved.runDue(), [],
      'replay must not invoke host again after durable receipt');
    assert.equal(policy.checked, 2);
    assert.deepEqual(policy.effects, [wakeId]);
    assert.equal(await store.verifyAudit(), true);
  } finally {
    try { await store?.close(); } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('permanent host revocation reaches durable dead-letter, never a fabricated receipt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-queued-host-dlq-'));
  let store;
  let checks = 0;
  let effects = 0;
  const hostVeto = async () => {
    checks++;
    throw new Error('host session revoked');
  };
  try {
    store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    const match = await matchOnce(store, engine);
    const first = await coordinator({
      store, engine, at: '2026-10-13T10:00:01.000Z',
      workerId: 'host-veto-first', maxAttempts: 2,
      deliverer: hostVeto,
    }).deliverMatched(match);
    assert.equal(first.status, 'retry_scheduled');
    assert.equal(checks, 1);
    await store.close();
    store = new PersistentEventStore(dir);
    await store.init();
    const afterRestart = scheduler({
      store,
      engine: new CompositeTriggerEngine(store),
      at: '2026-10-13T10:00:02.100Z',
      workerId: 'host-veto-after-restart',
      deliverer: hostVeto,
      maxAttempts: 2,
    });
    assert.deepEqual((await afterRestart.runDue()).map(row => row.status),
      ['dead_letter']);
    assert.equal(checks, 2);
    const wakeId = first.wake.wakeId;
    const status = store.getWakeDelivery(wakeId);
    assert.equal(status.status, 'dead_letter');
    assert.equal(status.runtimeReceiptId, null);
    assert.equal(store.latestWake(wakeId).status, 'dead_letter');
    assert.deepEqual(await afterRestart.runDue(), []);
    assert.equal(checks, 2);
    assert.equal(effects, 0);
    assert.equal(await store.verifyAudit(), true);
  } finally {
    try { await store?.close(); } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
