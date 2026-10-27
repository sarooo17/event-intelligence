import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindEmbeddedRuntimeIntegration,
  createActivationDispatcher,
  createDeterministicReceiptId,
  createEventIntelligence,
} from '../scripts/embedded-host-kit.mjs';

// Locally authored boundary probes only. NOT an independently authored host,
// a full v3 management matrix, a deployed app, or a durable receipt backend.
const activation = Object.freeze({
  activationVersion: '2',
  wake: {
    wakeId: 'wake-1', status: 'queued', runtimeReceiptId: null,
    matchedAt: '2026-10-27T00:00:00.000Z',
  },
  target: { runtime: 'generic', kind: 'workflow', id: 'work-1' },
  trigger: {
    triggerId: 'trigger-1', version: '1', description: null,
    pattern: {
      version: '2',
      root: { kind: 'event', ref: 'event_1' },
      partitionBy: [],
      selection: { overlap: 'disallow', afterMatch: 'skipPastLast', maxMatchesPerEvent: 10 },
      execution: {
        maxCandidates: 512, maxSemanticEvaluations: 16, maxBufferedEvents: 10000,
      },
    },
    lifecycle: { oneShot: true, cooldownMs: 0, completeOnGoal: false },
  },
  continuation: {
    instruction: 'Continue the host workflow.',
    contextPolicy: { evidence: 'matched_events', maxEvents: 20, includeData: true },
  },
  match: {
    matchId: 'match-1', status: 'matched', partitionKey: null,
    openedAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  },
  evidence: [],
  trust: {
    continuation: 'configured_trigger_instruction',
    evidence: 'untrusted_external_signal',
  },
});

function fakeHost(onClose = () => {}) {
  return {
    eventSources: [], runtime: {},
    async refreshMcpRegistry() { return []; },
    async mcpStatus() { return []; },
    async close() { onClose(); },
  };
}

test('headless consumer composes the canonical facade without tool/policy/agent requirements', async () => {
  let closeCount = 0;
  const instance = await createEventIntelligence({
    mcp: { list: () => [] },
    runtime: {
      deliver: () => ({ runtimeReceiptId: 'host-owned-work-1' }),
    },
    createHost: async () => fakeHost(() => { closeCount++; }),
  });
  assert.equal(instance.tools.length, 0);
  assert.equal(instance.toolCatalog.all.length, 0);
  await instance.close();
  await instance.close();
  assert.equal(closeCount, 1, 'EI cleanup must be idempotent');
});

test('tool mode without BOTH context and mutation control fails before host startup', async () => {
  let starts = 0;
  await assert.rejects(
    createEventIntelligence({
      runtime: {
        deliver: () => ({ runtimeReceiptId: 'receipt' }),
        resolveContext: () => ({ target: { runtime: 'x', kind: 'job', id: 'x' } }),
      },
      createHost: async () => { starts++; return fakeHost(); },
    }),
    error => error?.code === 'EI_HOST_CONTROL_REQUIRED',
  );
  assert.equal(starts, 0);
});

test('the existing bind helper supports unrelated native tool ABIs and rejects unknown exposure IDs', () => {
  const portable = {
    name: 'ei_read',
    description: 'Read a scoped event source',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    capability: {
      id: 'ei.demo.read', operation: 'read', resource: 'event',
      effect: 'none', durability: 'ephemeral', hostControl: 'none',
    },
    async execute() { return { ok: true, data: { count: 2 } }; },
  };
  const integration = { tools: [portable], close: async () => {} };
  const nativeRpc = [];
  const nativeAgent = [];
  const rpc = bindEmbeddedRuntimeIntegration(integration, {
    adapt: tool => ({ method: tool.name, invoke: args => tool.execute(args, {}) }),
    register: (tool, original) => nativeRpc.push({ tool, original }),
    capabilityIds: ['ei.demo.read'],
  });
  const agent = bindEmbeddedRuntimeIntegration(integration, {
    adapt: tool => ({ function: { name: tool.name, parameters: tool.inputSchema } }),
    register: (tool, original) => nativeAgent.push({ tool, original }),
    capabilityIds: ['ei.demo.read'],
  });
  assert.deepEqual(rpc.map(x => x.method), ['ei_read']);
  assert.deepEqual(agent.map(x => x.function.name), ['ei_read']);
  assert.equal(nativeRpc[0].original, portable);
  assert.equal(nativeAgent[0].original, portable);
  assert.equal(typeof rpc[0].invoke, 'function');
  assert.throws(() => bindEmbeddedRuntimeIntegration(integration, {
    adapt: () => { throw new Error('must not adapt'); },
    register: () => { throw new Error('must not register'); },
    capabilityIds: ['ei.unknown'],
  }), /unknown EI capability/i);
});

test('opaque agent, graph and headless-job targets use the same dispatcher and receipt protocol', async () => {
  for (const kind of ['agent', 'graph-checkpoint', 'job']) {
    const stored = new Set();
    const destinations = [];
    const dispatch = createActivationDispatcher({
      receiptNamespace: 'host-portability-probe',
      hasReceipt: id => stored.has(id),
      resolveTarget: target => ({ destination: target.kind, resourceId: target.id }),
      deliver: ({ target, receiptId, activation: delivered }) => {
        destinations.push({ target, receiptId, delivered });
        stored.add(receiptId);
        return { runtimeReceiptId: receiptId };
      },
    });
    const current = {
      ...activation,
      target: { runtime: 'universal', kind, id: 'id-' + kind },
      wake: { ...activation.wake, wakeId: 'wake-' + kind },
    };
    const receiptId = createDeterministicReceiptId(
      'host-portability-probe', 'wake-' + kind,
    );
    const first = await dispatch({ wake_id: current.wake.wakeId }, current);
    const replay = await dispatch({ wake_id: current.wake.wakeId }, current);
    assert.equal(first.runtimeReceiptId, receiptId);
    assert.equal(replay.duplicate, true);
    assert.equal(destinations.length, 1);
    assert.deepEqual(destinations[0].target, {
      destination: kind, resourceId: 'id-' + kind,
    });
    assert.equal(destinations[0].delivered.trust.evidence,
      'untrusted_external_signal');
  }
});

test('receipt precheck alone is not atomic: simultaneous deliveries can race in a weak host', async () => {
  let effects = 0;
  const dispatch = createActivationDispatcher({
    hasReceipt: async () => false, // Intentionally weak; no atomic host write.
    deliver: async ({ receiptId }) => {
      effects++;
      await Promise.resolve();
      return { runtimeReceiptId: receiptId };
    },
  });
  const [a, b] = await Promise.all([
    dispatch({ wake_id: activation.wake.wakeId }, activation),
    dispatch({ wake_id: activation.wake.wakeId }, activation),
  ]);
  assert.equal(a.runtimeReceiptId, b.runtimeReceiptId);
  assert.equal(effects, 2,
    'a non-atomic host must not be advertised as exactly-once');
});
