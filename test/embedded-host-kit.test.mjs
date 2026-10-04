import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createActivationDispatcher,
  createContinuationTarget,
  createEmbeddedEventIntelligence,
  createEventIntelligenceAgentTools,
} from '../scripts/embedded-host-kit.mjs';

const activation = {
  activationVersion: '2',
  wake: {
    wakeId: 'wake-1',
    status: 'queued',
    runtimeReceiptId: null,
    matchedAt: '2026-10-04T00:00:00.000Z',
  },
  target: {
    runtime: 'third-party-runtime',
    kind: 'thread',
    id: 'thread-123',
  },
  trigger: {
    triggerId: 'trigger-1',
    version: '1',
    description: null,
    pattern: {
      version: '2',
      root: { kind: 'event', ref: 'event_1' },
      partitionBy: [],
      selection: {
        overlap: 'disallow',
        afterMatch: 'skipPastLast',
        maxMatchesPerEvent: 10,
      },
      execution: {
        maxCandidates: 512,
        maxSemanticEvaluations: 16,
        maxBufferedEvents: 10000,
      },
    },
    lifecycle: {
      oneShot: true,
      cooldownMs: 0,
      completeOnGoal: false,
    },
  },
  continuation: {
    instruction: 'Continue the host task.',
    contextPolicy: {
      evidence: 'matched_events',
      maxEvents: 20,
      includeData: true,
    },
  },
  match: {
    matchId: 'match-1',
    status: 'matched',
    partitionKey: null,
    openedAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
  },
  evidence: [],
  trust: {
    continuation: 'configured_trigger_instruction',
    evidence: 'untrusted_external_signal',
  },
};

test('continuation targets accept arbitrary host kinds', () => {
  assert.deepEqual(
    createContinuationTarget({
      runtime: 'custom',
      kind: 'graph-checkpoint',
      id: 'abc',
    }),
    {
      runtime: 'custom',
      kind: 'graph-checkpoint',
      id: 'abc',
    },
  );
});

test('activation dispatcher is host-neutral and idempotent', async () => {
  const receipts = new Set();
  const deliveries = [];
  const dispatch = createActivationDispatcher({
    receiptId: ({ activation: value }) => `receipt:${value.wake.wakeId}`,
    hasReceipt: (id) => receipts.has(id),
    resolveTarget: (target) => ({ opaqueHostTarget: target.id }),
    deliver: ({ activation: value, target, receiptId }) => {
      deliveries.push({ value, target, receiptId });
      receipts.add(receiptId);
      return { runtimeReceiptId: receiptId };
    },
  });

  const first = await dispatch({ wake_id: 'wake-1' }, activation);
  const second = await dispatch({ wake_id: 'wake-1' }, activation);

  assert.equal(first.runtimeReceiptId, 'receipt:wake-1');
  assert.equal(second.duplicate, true);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0].target, { opaqueHostTarget: 'thread-123' });
});

test('portable tools keep target and authorization host-owned', async () => {
  const created = [];
  const host = {
    async refreshMcpRegistry() {},
    eventSources: Promise.resolve([
      {
        connectionId: 'github',
        serverId: 'github',
        eventName: 'github.branch.changed',
        description: 'Branch changed',
        delivery: ['poll'],
        inputSchema: { type: 'object' },
        payloadSchema: { type: 'object' },
      },
    ]),
    async planTrigger(input) {
      return {
        definition: {
          triggerId: 'planned-1',
          version: '1',
          target: input.target,
        },
        connectionIds: ['github'],
        warnings: [],
      };
    },
    triggerControl: {
      async createTrigger(input) {
        created.push(input);
        return {
          receiptId: 'trigger-receipt-1',
          definition: {
            ...input.definition,
            triggerId: 'planned-1',
            version: '1',
          },
          state: { status: 'active' },
        };
      },
    },
  };

  const tools = createEventIntelligenceAgentTools({
    host,
    names: {
      sources: 'watch_sources',
      create: 'watch_create',
    },
    resolveContext: () => ({
      target: {
        runtime: 'custom-runtime',
        kind: 'checkpoint',
        id: 'cp-1',
      },
      actor: {
        type: 'agent',
        principal_id: 'agent-1',
        tenant_id: 'tenant-1',
      },
      owner: {
        type: 'user',
        principal_id: 'user-1',
        tenant_id: 'tenant-1',
      },
    }),
    authorize: () => ({
      allowed: true,
      confirmationId: 'host-policy-1',
    }),
  });

  const sources = await tools[0].execute({}, {});
  assert.equal(sources.ok, true);
  assert.equal(sources.data.sources[0].eventName, 'github.branch.changed');

  const result = await tools[1].execute({
    events: [{ event: 'github.branch.changed' }],
    instruction: 'Continue when it changes.',
  }, {});

  assert.equal(result.ok, true);
  assert.equal(result.data.triggerId, 'planned-1');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].definition.target, {
    runtime: 'custom-runtime',
    kind: 'checkpoint',
    id: 'cp-1',
  });
  assert.equal(created[0].confirmationId, 'host-policy-1');
});

test('embedded install composes host MCP, activation delivery and portable tools', async () => {
  let capturedOptions;
  let closed = false;
  const fakeHost = {
    runtime: { marker: true },
    async refreshMcpRegistry() { return ['refreshed']; },
    async mcpStatus() { return ['ready']; },
    async scope() { return this; },
    async close() { closed = true; },
    eventSources: [],
  };

  const embedded = await createEmbeddedEventIntelligence({
    mcp: {
      listConnections: () => [],
    },
    activation: {
      deliver: ({ receiptId }) => ({ runtimeReceiptId: receiptId }),
    },
    createHost: async (options) => {
      capturedOptions = options;
      return fakeHost;
    },
  });

  assert.equal(typeof capturedOptions.mcpRegistry.listConnections, 'function');
  assert.equal(typeof capturedOptions.wake, 'function');
  assert.deepEqual(await embedded.status(), ['ready']);
  assert.deepEqual(await embedded.refresh(), ['refreshed']);
  await embedded.close();
  assert.equal(closed, true);
});
