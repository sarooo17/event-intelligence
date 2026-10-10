import assert from 'node:assert/strict';
import test from 'node:test';
import { runHostConformance } from '../scripts/host-conformance.mjs';
import { referenceHostAdapter } from '../conformance/reference-host.mjs';
import { createEventIntelligence } from '../scripts/embedded-host-kit.mjs';

test('neutral embedded facade passes full management conformance with real EI store and engine', async () => {
  const adapter = {
    name: 'neutral-facade-reference-host',
    createHarness(options) {
      return referenceHostAdapter.createHarness({
        ...options,
        useNeutralFacade: true,
      });
    },
  };
  const report = await runHostConformance(adapter, {
    profile: 'management',
    throwOnFailure: true,
  });
  assert.equal(report.schema, 'event-intelligence.host-conformance.v2');
  assert.equal(report.passed, true);
  assert.deepEqual(report.summary, {
    total: 6,
    passed: 6,
    failed: 0,
  });
  assert.ok(report.observability.eventNames.includes('ei.wake.delivered'));
});

test('neutral facade consults host control before creating any durable trigger', async () => {
  let writes = 0;
  let controlCalls = 0;
  const host = {
    runtime: {},
    eventSources: [],
    async refreshMcpRegistry() {},
    async mcpStatus() { return []; },
    async close() {},
    async planTrigger(input) {
      return {
        definition: {
          triggerId: 'denied-trigger',
          version: '1',
          target: input.target,
        },
        connectionIds: [],
        warnings: [],
      };
    },
    triggerControl: {
      async createTrigger() {
        writes++;
        throw new Error('must not mutate without policy');
      },
    },
  };
  const ei = await createEventIntelligence({
    runtime: {
      deliver: () => ({ runtimeReceiptId: 'unused' }),
      resolveContext: () => ({
        target: { runtime: 'host', kind: 'checkpoint', id: 'c-1' },
        actor: { type: 'agent', principal_id: 'agent-1' },
        owner: { type: 'user', principal_id: 'user-1' },
      }),
      control: () => {
        controlCalls++;
        return {
          action: 'return',
          result: { ok: false, error: { code: 'HOST_APPROVAL_REQUIRED' } },
        };
      },
    },
    createHost: async () => host,
  });
  const reply = await ei.toolCatalog.get('trigger_create').execute({
    events: [{ event: 'value.changed' }],
    instruction: 'Notify when matched',
  }, {});
  assert.equal(controlCalls, 1);
  assert.equal(writes, 0);
  assert.deepEqual(reply, {
    ok: false,
    error: { code: 'HOST_APPROVAL_REQUIRED' },
  });
  await ei.close();
});

test('neutral facade reuses durable host receipt after crash-before-ack and restart', async () => {
  const receipts = new Set();
  let deliveries = 0;
  let wake;
  const activation = {
    activationVersion: '2',
    wake: {
      wakeId: 'durable-wake-1',
      status: 'queued',
      runtimeReceiptId: null,
      matchedAt: '2026-10-01T12:00:00.000Z',
    },
    target: { runtime: 'host', kind: 'checkpoint', id: 'checkpoint-1' },
    trigger: {
      triggerId: 'resume-trigger', version: '1', description: null,
      pattern: {
        version: '2',
        root: { kind: 'event', ref: 'value' },
        partitionBy: [],
        selection: {
          overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100,
        },
        execution: {
          maxCandidates: 512, maxSemanticEvaluations: 0,
          maxBufferedEvents: 512,
        },
      },
      lifecycle: { oneShot: true, cooldownMs: 0, completeOnGoal: false },
    },
    continuation: {
      instruction: 'Continue after the event',
      contextPolicy: {
        evidence: 'refs_only', maxEvents: 50, includeData: false,
      },
    },
    match: {
      matchId: 'match-1', status: 'matched', partitionKey: null,
      openedAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-01T12:00:00.000Z',
    },
    evidence: [],
    trust: {
      continuation: 'configured_trigger_instruction',
      evidence: 'untrusted_external_signal',
    },
  };
  async function start() {
    return createEventIntelligence({
      runtime: {
        receiptNamespace: 'host-proof',
        hasReceipt: (id) => receipts.has(id),
        deliver: ({ receiptId }) => {
          deliveries++;
          receipts.add(receiptId);
          // Simulate crash after the host checkpoint was durably recorded,
          // but before the host acknowledges receipt back to EI.
          throw new Error('crash-after-host-receipt');
        },
      },
      createHost: async (options) => {
        wake = options.wake;
        return {
          runtime: {},
          async refreshMcpRegistry() {},
          async mcpStatus() { return []; },
          async close() {},
        };
      },
    });
  }

  const first = await start();
  const delivered = await wake({ wake_id: 'durable-wake-1' }, activation);
  assert.equal(delivered.duplicate, true);
  assert.equal(deliveries, 1);
  await first.close();

  const second = await start();
  const duplicate = await wake({ wake_id: 'durable-wake-1' }, activation);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.runtimeReceiptId, delivered.runtimeReceiptId);
  assert.equal(deliveries, 1);
  await second.close();
});
