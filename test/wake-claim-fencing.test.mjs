import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';

test('JSONL reference store rejects same-worker ABA generation for completion and failure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-wake-fence-'));
  const t0 = Date.parse('2026-10-08T10:00:00.000Z');
  let store;
  try {
    store = new PersistentEventStore(dir);
    await store.init();
    await store.ensureWakeDelivery({
      wakeId: 'aba', matchId: 'm', triggerId: 't', triggerVersion: '1',
      runtime: 'test', now: new Date(t0).toISOString(),
    });
    const a = await store.claimWakeDelivery('aba', {
      workerId: 'reused-worker-id',
      now: new Date(t0).toISOString(), leaseMs: 1000,
    });
    const b = await store.claimWakeDelivery('aba', {
      workerId: 'reused-worker-id',
      now: new Date(t0 + 1000).toISOString(), leaseMs: 1000,
    });
    assert.equal(a.attemptCount, 1);
    assert.equal(b.attemptCount, 2);
    assert.notEqual(a.attemptCount, b.attemptCount);
    await assert.rejects(
      () => store.completeWakeDelivery('aba', {
        workerId: 'reused-worker-id',
        attemptCount: a.attemptCount,
        runtimeReceiptId: 'stale',
      }),
      (error) => error.code === 'WAKE_DELIVERY_CLAIM_LOST',
    );
    await assert.rejects(
      () => store.failWakeDelivery('aba', {
        workerId: 'reused-worker-id',
        attemptCount: a.attemptCount, error: new Error('obsolete'),
      }),
      (error) => error.code === 'WAKE_DELIVERY_CLAIM_LOST',
    );
    await assert.rejects(
      () => store.failWakeDelivery('aba', {
        workerId: 'reused-worker-id',
        error: new Error('missing generation'),
      }),
      (error) => error.code === 'WAKE_DELIVERY_CLAIM_GENERATION_REQUIRED',
    );
    await store.completeWakeDelivery('aba', {
      workerId: 'reused-worker-id',
      attemptCount: b.attemptCount,
      runtimeReceiptId: 'current',
    });
    assert.equal(store.getWakeDelivery('aba').runtimeReceiptId, 'current');
    await store.close();
    store = new PersistentEventStore(dir);
    await store.init();
    assert.equal(store.getWakeDelivery('aba').runtimeReceiptId, 'current');
    assert.equal(store.getWakeDelivery('aba').attemptCount, 2);
  } finally {
    await store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
