import assert from 'node:assert/strict';
import test from 'node:test';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';

function lost() {
  const error = new Error('successor now owns delivery');
  error.code = 'WAKE_DELIVERY_CLAIM_LOST';
  return error;
}

function scenario({ failDeliverer = false } = {}) {
  const counters = { completed: 0, failed: 0, audited: 0 };
  const definition = {
    triggerId: 't', version: '1',
    target: { runtime: 'test', kind: 'task', id: 'task-1' },
  };
  const match = {
    matchId: 'm', triggerId: 't', triggerVersion: '1',
    status: 'matched', sourceEvents: [],
  };
  const store = {
    async listTriggers() { return [definition]; },
    async latestWake() {
      return { status: 'queued', wakeId: 'existing' };
    },
    async ensureWakeDelivery() {},
    async getWakeDelivery() {
      return { status: 'claimed', leaseOwner: 'successor', attemptCount: 2 };
    },
    async claimWakeDelivery() {
      return { status: 'claimed', leaseOwner: 'same-worker', attemptCount: 1 };
    },
    async completeWakeDelivery() {
      counters.completed++;
      throw lost();
    },
    async failWakeDelivery() {
      counters.failed++;
      throw lost();
    },
    async appendAudit() { counters.audited++; },
  };
  const coordinator = new CompositeWakeCoordinator({
    store,
    triggerEngine: {},
    workerId: 'same-worker',
    now: () => new Date('2026-10-09T10:00:00.000Z'),
    packetBuilder: () => ({ wake_id: 'opaque' }),
    deliverer: async () => {
      if (failDeliverer) throw new Error('provider failed after takeover');
      return { runtimeReceiptId: 'receipt-old' };
    },
  });
  return { coordinator, match, counters };
}

test('coordinator returns claim_lost after stale completion, without rescheduling successor', async () => {
  const { coordinator, match, counters } = scenario();
  const result = await coordinator.deliverMatched(match);
  assert.equal(result.status, 'claim_lost');
  assert.equal(result.delivery.attemptCount, 2);
  assert.equal(counters.completed, 1);
  assert.equal(counters.failed, 0);
  assert.equal(counters.audited, 0);
});

test('coordinator returns claim_lost if old provider error races with successor claim', async () => {
  const { coordinator, match, counters } = scenario({ failDeliverer: true });
  const result = await coordinator.deliverMatched(match);
  assert.equal(result.status, 'claim_lost');
  assert.equal(result.delivery.leaseOwner, 'successor');
  assert.equal(counters.completed, 0);
  assert.equal(counters.failed, 1);
  assert.equal(counters.audited, 0);
});
