import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import {
  PersistentEventStore,
} from '../scripts/lib/persistent-event-store.mjs';
import {
  validateSharedStoreCapabilities,
} from '../scripts/lib/store-capabilities.mjs';
import {
  createLocalEventIntelligenceRuntime,
} from '../scripts/lib/local-event-intelligence-runtime.mjs';

test('reference store advertises capabilities but is rejected as shared HA state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-store-capabilities-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    assert.deepEqual(
      store.storeCapabilities(),
      expectCapabilities({
        sharedState: 'single-process',
        wakeClaims: 'process-atomic',
        partitionLeases: 'process-atomic',
        mutableCompaction: 'atomic-snapshot',
      }),
    );
    const shared = validateSharedStoreCapabilities(store);
    assert.equal(shared.ok, false);
    assert.match(shared.errors.join('\n'), /sharedState must be strong/);

    await assert.rejects(
      () => createLocalEventIntelligenceRuntime({
        env: {
          DATA_DIR: dir,
          EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE: 'true',
          EVENT_INTELLIGENCE_WORKER_ID: 'worker-1',
        },
        store,
      }),
      (error) =>
        error.code === 'EVENT_INTELLIGENCE_SHARED_STORE_REQUIRED',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reference partition leases are mutually exclusive and reusable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-partition-leases-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const [a, b] = await Promise.all([
      store.claimPartitionLease('trigger@1:customer=A', {
        workerId: 'worker-a',
        now: '2026-09-30T10:00:00.000Z',
        leaseMs: 30000,
      }),
      store.claimPartitionLease('trigger@1:customer=A', {
        workerId: 'worker-b',
        now: '2026-09-30T10:00:00.000Z',
        leaseMs: 30000,
      }),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1);
    const owner = a ? 'worker-a' : 'worker-b';
    assert.equal(
      await store.releasePartitionLease(
        'trigger@1:customer=A',
        { workerId: owner },
      ),
      true,
    );
    const next = await store.claimPartitionLease(
      'trigger@1:customer=A',
      {
        workerId: 'worker-c',
        now: '2026-09-30T10:00:01.000Z',
        leaseMs: 30000,
      },
    );
    assert.equal(next.workerId, 'worker-c');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mutable-state compaction preserves current state across restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-store-compact-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();

    await store.putTrigger({
      triggerId: 'compact-trigger',
      version: '1',
      conditionOnly: true,
      clauses: [{
        id: 'e',
        event: 'e.event',
        arguments: {},
        where: [],
      }],
      pattern: { root: { kind: 'event', ref: 'e' } },
      withinMs: 60000,
      lifecycle: {
        oneShot: false,
        cooldownMs: 0,
        completeOnGoal: false,
      },
    });
    await store.setTriggerState(
      'compact-trigger',
      '1',
      'paused',
      { type: 'system', principal_id: 'first' },
    );
    await store.setTriggerState(
      'compact-trigger',
      '1',
      'active',
      { type: 'system', principal_id: 'second' },
    );
    await store.putMcpClientState({
      connectionId: 'conn',
      serverId: 'server',
      eventName: 'e.event',
      arguments: {},
      cursor: 'one',
      deliveryMode: 'poll',
    });
    await store.putMcpClientState({
      connectionId: 'conn',
      serverId: 'server',
      eventName: 'e.event',
      arguments: {},
      cursor: 'two',
      deliveryMode: 'poll',
    });

    const compacted = await store.compactMutableState();
    assert.equal(compacted.ok, true);
    await store.close();

    const restarted = new PersistentEventStore(dir);
    await restarted.init();
    assert.equal(
      restarted.getTriggerState('compact-trigger', '1').status,
      'active',
    );
    assert.equal(
      restarted.getMcpClientState('conn', 'e.event', {}).cursor,
      'two',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Pattern engine claims and releases distributed partition ownership', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-engine-partition-lease-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();

    let claims = 0;
    let releases = 0;
    const referenceClaim = store.claimPartitionLease.bind(store);
    const referenceRelease = store.releasePartitionLease.bind(store);
    store.storeCapabilities = () => ({
      version: '1',
      sharedState: 'strong',
      scopeIsolation: 'strong',
      wakeClaims: 'distributed-atomic',
      partitionLeases: 'distributed-atomic',
      mutableCompaction: 'atomic-snapshot',
      readModel: 'synchronous-materialized-test',
    });
    store.claimPartitionLease = async (...args) => {
      claims += 1;
      return referenceClaim(...args);
    };
    store.releasePartitionLease = async (...args) => {
      releases += 1;
      return referenceRelease(...args);
    };

    const engine = new CompositeTriggerEngine(
      store,
      null,
      undefined,
      {
        workerId: 'worker-a',
        partitionLeaseMs: 30000,
      },
    );
    await engine.register({
      triggerId: 'leased-pattern',
      version: '1',
      conditionOnly: true,
      clauses: [{
        id: 'order',
        event: 'order.created',
        arguments: {},
        where: [],
      }],
      pattern: {
        version: '2',
        root: { kind: 'event', ref: 'order' },
        partitionBy: [{
          key: 'customer',
          fields: [{ ref: 'order', path: 'customer' }],
        }],
        selection: {
          overlap: 'disallow',
          afterMatch: 'skipPastLast',
          maxMatchesPerEvent: 10,
        },
        execution: {
          maxCandidates: 64,
          maxSemanticEvaluations: 0,
          maxBufferedEvents: 100,
        },
      },
      withinMs: 60000,
      lifecycle: {
        oneShot: false,
        cooldownMs: 0,
        completeOnGoal: false,
      },
    });

    const result = await engine.ingest({
      traceId: 'lease-event',
      sourceEventId: 'order-1',
      name: 'order.created',
      occurredAt: '2026-09-30T10:00:00.000Z',
      provider: 'test',
      serverId: 'orders',
      subscriptionArguments: {},
      data: { customer: 'ACME' },
    });
    assert.equal(result.some((entry) => entry.matched), true);
    assert.equal(claims, 1);
    assert.equal(releases, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function expectCapabilities(partial) {
  return {
    version: '1',
    sharedState: 'single-process',
    scopeIsolation: 'strong',
    wakeClaims: 'process-atomic',
    partitionLeases: 'process-atomic',
    mutableCompaction: 'atomic-snapshot',
    readModel: 'synchronous-materialized',
    ...partial,
  };
}
