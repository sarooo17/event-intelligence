import assert from 'node:assert/strict';
import {
  describeStoreCapabilities,
  validateSharedStoreCapabilities,
} from './store-capabilities.mjs';

export async function runStoreConformance({
  createStore,
  expectShared = false,
} = {}) {
  if (typeof createStore !== 'function') {
    throw new Error('runStoreConformance requires createStore()');
  }

  const store = await createStore();
  if (typeof store.init === 'function') await store.init();

  const report = {
    schema: 'event-intelligence.store-conformance.v1',
    capabilities: describeStoreCapabilities(store),
    checks: [],
  };

  const check = async (name, fn) => {
    await fn();
    report.checks.push({ name, ok: true });
  };

  await check('trigger-state round trip', async () => {
    await store.putTrigger({
      protocolVersion: '0.1.0',
      schemaVersion: 'trigger.v0.1',
      triggerId: 'store-conf-trigger',
      version: '1',
      conditionOnly: true,
      clauses: [{
        id: 'event',
        event: 'store.conformance.event',
        arguments: {},
        where: [],
      }],
      expression: { kind: 'anyOf', refs: ['event'] },
      temporal: [],
      withinMs: 60000,
      lifecycle: {
        oneShot: false,
        cooldownMs: 0,
        completeOnGoal: false,
      },
    });
    await store.setTriggerState(
      'store-conf-trigger',
      '1',
      'paused',
      { type: 'system', principal_id: 'conformance' },
    );
    assert.equal(
      store.getTriggerState('store-conf-trigger', '1').status,
      'paused',
    );
  });

  await check('wake claim exclusion', async () => {
    await store.ensureWakeDelivery({
      wakeId: 'store-conf-wake',
      sourceType: 'event',
      sourceId: 'source-1',
      runtime: 'conformance',
      now: '2026-09-30T00:00:00.000Z',
    });
    const [a, b] = await Promise.all([
      store.claimWakeDelivery('store-conf-wake', {
        workerId: 'a',
        now: '2026-09-30T00:00:00.000Z',
        leaseMs: 30000,
      }),
      store.claimWakeDelivery('store-conf-wake', {
        workerId: 'b',
        now: '2026-09-30T00:00:00.000Z',
        leaseMs: 30000,
      }),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1);
  });

  if (
    typeof store.claimPartitionLease === 'function' &&
    typeof store.releasePartitionLease === 'function'
  ) {
    await check('partition lease exclusion', async () => {
      const [a, b] = await Promise.all([
        store.claimPartitionLease('partition-1', {
          workerId: 'a',
          now: '2026-09-30T00:00:00.000Z',
          leaseMs: 30000,
        }),
        store.claimPartitionLease('partition-1', {
          workerId: 'b',
          now: '2026-09-30T00:00:00.000Z',
          leaseMs: 30000,
        }),
      ]);
      assert.equal([a, b].filter(Boolean).length, 1);
      const owner = a ? 'a' : 'b';
      await store.releasePartitionLease('partition-1', {
        workerId: owner,
      });
    });
  }

  if (typeof store.compactMutableState === 'function') {
    await check('mutable-state compaction', async () => {
      const result = await store.compactMutableState();
      assert.equal(result?.ok, true);
    });
  }

  const shared = validateSharedStoreCapabilities(store);
  if (expectShared) {
    assert.equal(shared.ok, true, shared.errors.join('; '));
  }
  report.sharedReady = shared.ok;
  report.sharedErrors = shared.errors;

  if (typeof store.close === 'function') await store.close();
  return report;
}
