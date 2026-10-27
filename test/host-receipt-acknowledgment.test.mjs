import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createActivationDispatcher,
  createDeterministicReceiptId,
  createEventIntelligence,
} from '../scripts/embedded-host-kit.mjs';

// EI-maintained mock. No real durable host receipt and no third-party signoff.
const activation = {
  activationVersion: '2',
  wake: {
    wakeId: 'wake-ack-1', status: 'queued', runtimeReceiptId: null,
    matchedAt: '2026-10-27T00:00:00.000Z',
  },
  target: { runtime: 'arbitrary', kind: 'graph-checkpoint', id: 'cp-22' },
  trigger: {
    triggerId: 'trigger-ack', version: '1', description: null,
    pattern: {
      version: '2',
      root: { kind: 'event', ref: 'event_1' },
      partitionBy: [],
      selection: {
        overlap: 'disallow', afterMatch: 'skipPastLast', maxMatchesPerEvent: 10,
      },
      execution: {
        maxCandidates: 512, maxSemanticEvaluations: 16, maxBufferedEvents: 10000,
      },
    },
    lifecycle: { oneShot: true, cooldownMs: 0, completeOnGoal: false },
  },
  continuation: {
    instruction: 'Continue the host checkpoint.',
    contextPolicy: { evidence: 'matched_events', maxEvents: 20, includeData: true },
  },
  match: {
    matchId: 'match-ack', status: 'matched', partitionKey: null,
    openedAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  },
  evidence: [],
  trust: {
    continuation: 'configured_trigger_instruction',
    evidence: 'untrusted_external_signal',
  },
};
const packet = { wake_id: activation.wake.wakeId };
const contract = { version: '1', required: ['wake.receipts'] };

function fakeHost(options) {
  return {
    eventSources: [],
    runtime: {},
    async refreshMcpRegistry() { return []; },
    async mcpStatus() { return []; },
    async close() {},
    wake: options.wake,
  };
}

async function facade(runtime, hostContract = contract) {
  let capture;
  const integration = await createEventIntelligence({
    runtime,
    ...(hostContract ? { hostContract } : {}),
    createHost: async options => {
      capture = fakeHost(options);
      return capture;
    },
  });
  return {
    wake: capture.wake,
    close: () => integration.close(),
    negotiation: integration.hostContract,
  };
}

test('HostContract wake.receipts rejects void deliver without manufacturing a receipt', async () => {
  let calls = 0;
  const host = await facade({
    receiptNamespace: 'arbitrary-host', hasReceipt: () => false,
    deliver: () => { calls++; },
  });
  assert.equal(host.negotiation.readiness, 'configuration-validated');
  await assert.rejects(host.wake(packet, activation), e =>
    e?.code === 'EVENT_ACTIVATION_RECEIPT_ACK_REQUIRED');
  await assert.rejects(host.wake(packet, activation), e =>
    e?.code === 'EVENT_ACTIVATION_RECEIPT_ACK_REQUIRED');
  assert.equal(calls, 2, 'unacknowledged host delivery remains retryable');
  await host.close();
});

test('HostContract receipt acknowledges explicit host ID for an opaque graph target', async () => {
  const expected = createDeterministicReceiptId('arbitrary-host', activation.wake.wakeId);
  const host = await facade({
    receiptNamespace: 'arbitrary-host', hasReceipt: () => false,
    resolveTarget: target => ({ kind: target.kind, checkpoint: target.id }),
    deliver: ({ target, receiptId }) => {
      assert.equal(receiptId, expected);
      assert.deepEqual(target, { kind: 'graph-checkpoint', checkpoint: 'cp-22' });
      return { runtimeReceiptId: receiptId, status: 'persisted' };
    },
  });
  assert.equal((await host.wake(packet, activation)).runtimeReceiptId, expected);
  await host.close();
});

test('post-commit missing ack can reconcile through authoritative host hasReceipt', async () => {
  let persisted = false;
  let committed = 0;
  const host = await facade({
    receiptNamespace: 'arbitrary-host', hasReceipt: () => persisted,
    deliver: () => { persisted = true; committed++; }, // crash after write, before ack
  });
  const receipt = await host.wake(packet, activation);
  assert.equal(receipt.duplicate, true);
  assert.equal(receipt.runtimeReceiptId,
    createDeterministicReceiptId('arbitrary-host', activation.wake.wakeId));
  await host.wake(packet, activation);
  assert.equal(committed, 1);
  await host.close();
});

test('uncontracted low-level and facade delivery retain historical void fallback', async () => {
  const direct = createActivationDispatcher({
    deliver: () => undefined,
  });
  assert.equal((await direct(packet, activation)).runtimeReceiptId,
    activation.wake.wakeId);
  const host = await facade({ deliver: () => undefined }, null);
  assert.equal((await host.wake(packet, activation)).runtimeReceiptId,
    activation.wake.wakeId);
  await host.close();
});

test('direct strict dispatcher rejects missing ack and invalid option', async () => {
  assert.throws(() => createActivationDispatcher({
    deliver: () => ({ runtimeReceiptId: 'id' }),
    requireExplicitReceipt: 'yes',
  }), /requireExplicitReceipt must be a boolean/);
  const dispatcher = createActivationDispatcher({
    deliver: () => undefined, requireExplicitReceipt: true,
  });
  await assert.rejects(dispatcher(packet, activation), e =>
    e?.code === 'EVENT_ACTIVATION_RECEIPT_ACK_REQUIRED');
});

test('strict receipt precheck does not claim concurrent exactly-once host effects', async () => {
  let effects = 0;
  const dispatcher = createActivationDispatcher({
    requireExplicitReceipt: true,
    receiptNamespace: 'arbitrary-host',
    hasReceipt: () => false, // intentionally non-atomic
    deliver: async ({ receiptId }) => {
      effects++;
      await Promise.resolve();
      return { runtimeReceiptId: receiptId };
    },
  });
  const receipts = await Promise.all([
    dispatcher(packet, activation),
    dispatcher(packet, activation),
  ]);
  assert.equal(receipts[0].runtimeReceiptId, receipts[1].runtimeReceiptId);
  assert.equal(effects, 2, 'only host atomic upsert can deduplicate effects');
});
