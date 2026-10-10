import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EVENT_INTELLIGENCE_CAPABILITIES,
  EMBEDDED_OPERATION_REGISTRY,
  bindEmbeddedRuntimeIntegration,
  createActivationDispatcher,
  createDeterministicReceiptId,
  createContinuationTarget,
  createEmbeddedEventIntelligence,
  createEmbeddedRuntimeIntegration,
  createEventIntelligence,
  createEventIntelligenceAgentTools,
  createEventSourceRegistry,
  createPortableToolCatalog,
  createResultReference,
  summarizeEventSourceStatus,
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

test('activation dispatcher can derive a deterministic receipt from a namespace', async () => {
  const delivered = [];
  const dispatch = createActivationDispatcher({
    receiptNamespace: 'runtime-a',
    deliver: ({ receiptId }) => {
      delivered.push(receiptId);
      return { runtimeReceiptId: receiptId };
    },
  });

  const result = await dispatch({ wake_id: 'wake-1' }, activation);
  assert.equal(
    result.runtimeReceiptId,
    createDeterministicReceiptId('runtime-a', 'wake-1'),
  );
  assert.deepEqual(delivered, [result.runtimeReceiptId]);
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
    control: () => ({
      action: 'execute',
      execution: {
        receiptId: 'host-policy-1',
      },
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

test('portable trigger management is owner-scoped and covers lifecycle', async () => {
  const owner = { type: 'user', principal_id: 'user-1', tenant_id: 'tenant-1' };
  const foreignOwner = { type: 'user', principal_id: 'user-2', tenant_id: 'tenant-1' };
  const rows = [
    {
      definition: {
        triggerId: 'watch-1',
        version: '1',
        description: 'Watch the primary source',
        clauses: [{ id: 'source', serverId: 'demo', event: 'demo.changed' }],
        lifecycle: { oneShot: false, maxFirings: 3 },
        target: { runtime: 'custom-runtime', kind: 'task', id: 'task-1' },
      },
      state: {
        status: 'active',
        fireCount: 1,
        connectionIds: ['demo-connection'],
        owner,
      },
    },
    {
      definition: {
        triggerId: 'foreign-watch',
        version: '1',
        clauses: [{ id: 'source', serverId: 'demo', event: 'demo.changed' }],
        lifecycle: { oneShot: true },
        target: { runtime: 'custom-runtime', kind: 'task', id: 'task-2' },
      },
      state: {
        status: 'active',
        fireCount: 0,
        connectionIds: ['demo-connection'],
        owner: foreignOwner,
      },
    },
  ];
  const mutations = [];
  const sameOwner = (candidate, expected) =>
    candidate?.type === expected?.type &&
    candidate?.principal_id === expected?.principal_id &&
    candidate?.tenant_id === expected?.tenant_id;

  const host = {
    async refreshMcpRegistry() {},
    async scope() { return this; },
    eventSources: [],
    async planTrigger(input) {
      return {
        definition: {
          triggerId: input.triggerId,
          version: input.version,
          clauses: input.events.map((event, index) => ({
            id: event.id ?? `event_${index + 1}`,
            serverId: event.serverId ?? 'demo',
            event: event.event,
          })),
          lifecycle: input.lifecycle,
          target: input.target,
          continuation: input.continuation,
        },
        connectionIds: ['demo-connection'],
        warnings: [],
      };
    },
    triggerInspector: {
      inspect({ triggerId, version }) {
        return {
          triggerId,
          version,
          explanation: 'deterministic inspection',
        };
      },
    },
    triggerControl: {
      async listTriggers({ owner: requestedOwner } = {}) {
        return rows.filter((entry) =>
          !requestedOwner || sameOwner(entry.state.owner, requestedOwner)
        );
      },
      async pauseTrigger(input) {
        mutations.push(['pause', input]);
        rows[0].state = { ...rows[0].state, status: 'paused' };
        return {
          receiptId: 'pause-receipt',
          action: 'pause',
          definition: rows[0].definition,
          state: rows[0].state,
        };
      },
      async resumeTrigger(input) {
        mutations.push(['resume', input]);
        rows[0].state = { ...rows[0].state, status: 'active' };
        return {
          receiptId: 'resume-receipt',
          action: 'resume',
          definition: rows[0].definition,
          state: rows[0].state,
        };
      },
      async deleteTrigger(input) {
        mutations.push(['delete', input]);
        rows[0].state = { ...rows[0].state, status: 'deleted' };
        return {
          receiptId: 'delete-receipt',
          action: 'delete',
          definition: rows[0].definition,
          state: rows[0].state,
        };
      },
      async updateTrigger(input) {
        mutations.push(['update', input]);
        rows[0].state = { ...rows[0].state, status: 'completed' };
        const next = {
          definition: input.definition,
          state: {
            status: 'active',
            fireCount: 0,
            connectionIds: input.connectionIds,
            owner,
          },
        };
        rows.push(next);
        return {
          receiptId: 'update-receipt',
          action: 'update',
          previous: {
            definition: rows[0].definition,
            state: rows[0].state,
          },
          definition: next.definition,
          state: next.state,
        };
      },
      async createTrigger() {
        throw new Error('not used');
      },
    },
  };

  const tools = createEventIntelligenceAgentTools({
    host,
    resolveContext: () => ({
      target: { runtime: 'custom-runtime', kind: 'task', id: 'current-task' },
      actor: { type: 'agent', principal_id: 'agent-1', tenant_id: 'tenant-1' },
      owner,
    }),
    control: ({ action }) => ({
      action: 'execute',
      execution: { receiptId: `policy:${action}` },
    }),
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const listed = await byName.get('trigger_list').execute({
    status: 'active',
    connection_id: 'demo-connection',
    remaining_only: true,
  }, {});
  assert.equal(listed.ok, true);
  assert.equal(listed.data.total, 1);
  assert.equal(listed.data.triggers[0].triggerId, 'watch-1');
  assert.equal(listed.data.triggers[0].remainingFirings, 2);
  assert.equal(
    listed.data.triggers.some((entry) => entry.triggerId === 'foreign-watch'),
    false,
  );

  const inspected = await byName.get('trigger_inspect').execute({
    trigger_id: 'watch-1',
  }, {});
  assert.equal(inspected.ok, true);
  assert.equal(inspected.data.triggerId, 'watch-1');

  const paused = await byName.get('trigger_pause').execute({
    trigger_id: 'watch-1',
  }, {});
  assert.equal(paused.ok, true);
  assert.equal(paused.data.state.status, 'paused');

  const resumed = await byName.get('trigger_resume').execute({
    trigger_id: 'watch-1',
  }, {});
  assert.equal(resumed.ok, true);
  assert.equal(resumed.data.state.status, 'active');

  const updated = await byName.get('trigger_update').execute({
    trigger_id: 'watch-1',
    events: [{ event: 'demo.changed', serverId: 'demo' }],
    instruction: 'Continue after the next matching event.',
    one_shot: false,
    max_firings: 4,
  }, {});
  assert.equal(updated.ok, true);
  assert.equal(updated.data.previousVersion, '1');
  assert.equal(updated.data.version, '2');
  assert.deepEqual(updated.data.state.status, 'active');
  assert.deepEqual(
    rows.at(-1).definition.target,
    { runtime: 'custom-runtime', kind: 'task', id: 'task-1' },
  );

  const deleted = await byName.get('trigger_delete').execute({
    trigger_id: 'watch-1',
    version: '2',
  }, {});
  assert.equal(deleted.ok, true);
  assert.equal(deleted.data.state.status, 'deleted');

  assert.deepEqual(
    mutations.map(([action]) => action),
    ['pause', 'resume', 'update', 'delete'],
  );
  for (const [, input] of mutations) {
    assert.equal(input.actor.principal_id, 'agent-1');
    assert.equal(input.owner.principal_id, 'user-1');
    assert.match(input.confirmationId, /^policy:trigger\./);
  }
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

test('capability metadata is EI-neutral and drives host-side exposure', () => {
  assert.deepEqual(EVENT_INTELLIGENCE_CAPABILITIES.eventSourcesList, {
    id: 'event-intelligence.event-sources.list',
    operation: 'read',
    resource: 'event-source',
    effect: 'none',
    durability: 'ephemeral',
    hostControl: 'none',
  });
  assert.deepEqual(EVENT_INTELLIGENCE_CAPABILITIES.triggerCreate, {
    id: 'event-intelligence.trigger.create',
    operation: 'create',
    resource: 'trigger',
    effect: 'durable-state',
    durability: 'durable',
    hostControl: 'required',
  });

  const tools = [
    {
      name: 'read',
      capability: EVENT_INTELLIGENCE_CAPABILITIES.eventSourcesList,
    },
    {
      name: 'write',
      capability: EVENT_INTELLIGENCE_CAPABILITIES.triggerCreate,
    },
  ];
  const catalog = createPortableToolCatalog(tools);
  assert.equal(catalog.get('read').name, 'read');
  assert.deepEqual(
    catalog.list({
      capabilityIds: ['event-intelligence.trigger.create'],
    }).map((tool) => tool.name),
    ['write'],
  );
});

test('event source registry is host-owned and runtime-neutral', async () => {
  let listener = null;
  const connections = [{ id: 'events-a' }];
  const registry = createEventSourceRegistry({
    list: () => connections,
    subscribe(callback) {
      listener = callback;
      return () => {
        listener = null;
      };
    },
  });

  assert.deepEqual(await registry.list(), connections);
  let refreshed = 0;
  const unsubscribe = registry.subscribe(() => {
    refreshed += 1;
  });
  listener();
  assert.equal(refreshed, 1);
  unsubscribe();
  assert.equal(listener, null);
});

test('host control may interrupt without EI interpreting approval semantics', async () => {
  let created = 0;
  const host = {
    async refreshMcpRegistry() {},
    eventSources: [],
    async planTrigger(input) {
      return {
        definition: {
          triggerId: 'planned-interrupt',
          version: '1',
          target: input.target,
        },
        connectionIds: [],
        warnings: [],
      };
    },
    triggerControl: {
      async createTrigger() {
        created += 1;
        throw new Error('must not execute');
      },
    },
  };

  const tools = createEventIntelligenceAgentTools({
    host,
    resolveContext: () => ({
      target: {
        runtime: 'opaque-host',
        kind: 'continuation',
        id: 'c-1',
      },
      actor: {
        type: 'agent',
        principal_id: 'agent-1',
      },
      owner: {
        type: 'user',
        principal_id: 'user-1',
      },
    }),
    control: ({ capability }) => ({
      action: 'return',
      result: {
        ok: false,
        control: {
          kind: 'host-interrupt',
          capabilityId: capability.id,
          requestId: 'approval-123',
        },
      },
    }),
  });

  const result = await tools[1].execute({
    events: [{ event: 'demo.changed' }],
    instruction: 'Continue after the change.',
  }, {});

  assert.equal(created, 0);
  assert.deepEqual(result, {
    ok: false,
    control: {
      kind: 'host-interrupt',
      capabilityId: 'event-intelligence.trigger.create',
      requestId: 'approval-123',
    },
  });
});

test('host control may throw a native interrupt without EI swallowing it', async () => {
  const nativeInterrupt = Object.assign(new Error('host paused execution'), {
    name: 'HostInterrupt',
    interruptId: 'interrupt-1',
  });
  const host = {
    async refreshMcpRegistry() {},
    eventSources: [],
    async planTrigger(input) {
      return {
        definition: {
          triggerId: 'planned-native-interrupt',
          version: '1',
          target: input.target,
        },
        connectionIds: [],
        warnings: [],
      };
    },
    triggerControl: {
      async createTrigger() {
        throw new Error('must not execute');
      },
    },
  };

  const tools = createEventIntelligenceAgentTools({
    host,
    resolveContext: () => ({
      target: {
        runtime: 'opaque-host',
        kind: 'continuation',
        id: 'c-native',
      },
    }),
    control: () => {
      throw nativeInterrupt;
    },
  });

  await assert.rejects(
    tools[1].execute({
      events: [{ event: 'demo.changed' }],
      instruction: 'Resume later.',
    }, {}),
    (error) => error === nativeInterrupt,
  );
});

test('host may project canonical EI failures without changing EI semantics', async () => {
  const host = {
    async refreshMcpRegistry() {},
    eventSources: [],
    async planTrigger() {
      throw new Error('source unavailable');
    },
    triggerControl: {
      async createTrigger() {
        throw new Error('must not execute');
      },
    },
  };

  const tools = createEventIntelligenceAgentTools({
    host,
    resolveContext: () => ({
      target: {
        runtime: 'projection-host',
        kind: 'task',
        id: 'projection-error-1',
      },
    }),
    control: () => ({ action: 'execute' }),
    projectError: ({ phase, result }) => ({
      ...result,
      hostPresentation: {
        phase,
        message: result.error?.message,
      },
    }),
  });

  const result = await tools[1].execute({
    events: [{ event: 'demo.changed' }],
    instruction: 'Resume later.',
  }, {});

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'EVENT_TRIGGER_PLAN_FAILED');
  assert.deepEqual(result.hostPresentation, {
    phase: 'trigger.plan',
    message: 'source unavailable',
  });
});

test('error projection failure falls back to the canonical EI error', async () => {
  const host = {
    async refreshMcpRegistry() {},
    eventSources: [],
    async planTrigger() {
      throw new Error('still canonical');
    },
    triggerControl: {
      async createTrigger() {
        throw new Error('must not execute');
      },
    },
  };

  const tools = createEventIntelligenceAgentTools({
    host,
    resolveContext: () => ({
      target: {
        runtime: 'projection-host',
        kind: 'task',
        id: 'projection-error-2',
      },
    }),
    control: () => ({ action: 'execute' }),
    projectError: () => {
      throw new Error('presentation unavailable');
    },
  });

  const result = await tools[1].execute({
    events: [{ event: 'demo.changed' }],
    instruction: 'Resume later.',
  }, {});

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'EVENT_TRIGGER_PLAN_FAILED',
      message: 'still canonical',
    },
  });
});

test('legacy authorize failures remain normalized tool results', async () => {
  const host = {
    async refreshMcpRegistry() {},
    eventSources: [],
    async planTrigger(input) {
      return {
        definition: {
          triggerId: 'planned-legacy-auth',
          version: '1',
          target: input.target,
        },
        connectionIds: [],
        warnings: [],
      };
    },
    triggerControl: {
      async createTrigger() {
        throw new Error('must not execute');
      },
    },
  };

  const tools = createEventIntelligenceAgentTools({
    host,
    resolveContext: () => ({
      target: {
        runtime: 'legacy-host',
        kind: 'continuation',
        id: 'legacy-1',
      },
    }),
    authorize: async () => {
      throw new Error('legacy authorization unavailable');
    },
  });

  const result = await tools[1].execute({
    events: [{ event: 'demo.changed' }],
    instruction: 'Resume later.',
  }, {});

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'EVENT_TRIGGER_CREATE_FAILED',
      message: 'legacy authorization unavailable',
    },
  });
});

test('projection failure after durable creation falls back to success', async () => {
  let created = 0;
  const host = {
    async refreshMcpRegistry() {},
    eventSources: [],
    async planTrigger(input) {
      return {
        definition: {
          triggerId: 'planned-projection-fallback',
          version: '1',
          target: input.target,
        },
        connectionIds: [],
        warnings: [],
      };
    },
    triggerControl: {
      async createTrigger(input) {
        created += 1;
        return {
          receiptId: 'receipt-projection-fallback',
          definition: input.definition,
          state: { status: 'active' },
        };
      },
    },
  };

  const tools = createEventIntelligenceAgentTools({
    host,
    resolveContext: () => ({
      target: {
        runtime: 'projection-host',
        kind: 'continuation',
        id: 'projection-1',
      },
      actor: { type: 'agent', principal_id: 'agent-1' },
      owner: { type: 'user', principal_id: 'user-1' },
    }),
    control: () => ({ action: 'execute' }),
    projectResult: () => {
      throw new Error('projection unavailable');
    },
  });

  const result = await tools[1].execute({
    events: [{ event: 'demo.changed' }],
    instruction: 'Resume later.',
  }, {});

  assert.equal(created, 1);
  assert.equal(result.ok, true);
  assert.equal(result.data.receiptId, 'receipt-projection-fallback');
  assert.equal(result.data.triggerId, 'planned-projection-fallback');
  assert.equal(result.data.state.status, 'active');
});

test('result projection can externalize large results behind host references', async () => {
  const host = {
    async refreshMcpRegistry() {},
    eventSources: [{
      connectionId: 'big',
      serverId: 'big',
      eventName: 'big.event',
      description: 'Large source metadata',
      delivery: ['poll'],
      inputSchema: { type: 'object' },
      payloadSchema: { type: 'object' },
    }],
    async planTrigger() {
      throw new Error('not used');
    },
    triggerControl: {
      async createTrigger() {
        throw new Error('not used');
      },
    },
  };

  const tools = createEventIntelligenceAgentTools({
    host,
    resolveContext: () => ({
      target: {
        runtime: 'custom',
        kind: 'task',
        id: 't-1',
      },
      actor: { type: 'agent', principal_id: 'a-1' },
      owner: { type: 'user', principal_id: 'u-1' },
    }),
    control: () => ({ action: 'execute' }),
    projectResult: ({ capability, value }) => ({
      reference: createResultReference({
        id: 'result-1',
        kind: 'host-result',
        metadata: {
          capabilityId: capability.id,
          count: value.sources.length,
        },
      }),
      summary: '1 event source',
    }),
  });

  const result = await tools[0].execute({}, {});
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result, 'data'), false);
  assert.deepEqual(result.result, {
    reference: {
      id: 'result-1',
      kind: 'host-result',
      metadata: {
        capabilityId: 'event-intelligence.event-sources.list',
        count: 1,
      },
    },
    summary: '1 event source',
  });
});

test('embedded runtime integration composes neutral sources, tools, control and projection', async () => {
  let capturedOptions;
  const fakeHost = {
    runtime: { marker: 'runtime-neutral' },
    eventSources: Promise.resolve([]),
    async refreshMcpRegistry() {
      return [];
    },
    async mcpStatus() {
      return [];
    },
    async scope() {
      return this;
    },
    async close() {},
    async planTrigger(input) {
      return {
        definition: {
          triggerId: 'generic-1',
          version: '1',
          target: input.target,
        },
        connectionIds: [],
        warnings: [],
      };
    },
    triggerControl: {
      async createTrigger(input) {
        return {
          receiptId: 'receipt-1',
          definition: input.definition,
          state: { status: 'active' },
        };
      },
    },
  };
  const eventSources = createEventSourceRegistry({
    list: () => [],
  });

  const integration = await createEmbeddedRuntimeIntegration({
    eventSources,
    tooling: {
      resolveContext: () => ({
        target: {
          runtime: 'vendor-independent-host',
          kind: 'checkpoint',
          id: 'checkpoint-7',
        },
        actor: {
          type: 'agent',
          principal_id: 'agent-7',
        },
        owner: {
          type: 'user',
          principal_id: 'user-7',
        },
      }),
      control: () => ({
        action: 'execute',
        execution: { receiptId: 'policy-receipt-7' },
      }),
      projectResult: ({ value }) => ({ inline: value }),
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
  assert.deepEqual(
    [...await integration.eventSources.list()],
    [...await eventSources.list()],
  );
  assert.deepEqual(
    integration.capabilities.map((capability) => capability.id),
    [
      'event-intelligence.event-sources.list',
      'event-intelligence.trigger.create',
      'event-intelligence.trigger.list',
      'event-intelligence.trigger.inspect',
      'event-intelligence.trigger.pause',
      'event-intelligence.trigger.resume',
      'event-intelligence.trigger.delete',
      'event-intelligence.trigger.update',
    ],
  );
  assert.deepEqual(
    integration.toolCatalog.list({
      capabilityIds: ['event-intelligence.event-sources.list'],
    }).map((tool) => tool.name),
    ['event_sources_list'],
  );

  const created = await integration.toolCatalog.get('trigger_create').execute({
    events: [{ event: 'demo.changed' }],
    instruction: 'Resume.',
  }, {});
  assert.equal(created.ok, true);
  assert.equal(created.data.triggerId, 'generic-1');
});



test('embedded runtime integration does not require a tool system', async () => {
  const fakeHost = {
    runtime: { marker: 'headless-runtime' },
    eventSources: [],
    async refreshMcpRegistry() { return []; },
    async mcpStatus() { return []; },
    async scope() { return this; },
    async close() {},
  };

  const integration = await createEmbeddedRuntimeIntegration({
    eventSources: createEventSourceRegistry({ list: () => [] }),
    activation: {
      deliver: ({ receiptId }) => ({ runtimeReceiptId: receiptId }),
    },
    createHost: async () => fakeHost,
  });

  assert.deepEqual(integration.tools, []);
  assert.deepEqual(integration.capabilities, []);
});

test('embedded host kit contains no named-runtime branch', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../scripts/embedded-host-kit.mjs', import.meta.url), 'utf8')
  );
  assert.doesNotMatch(
    source,
    /if\s*\([^)]*runtime\s*===\s*['"][^'"]+['"]/,
  );
});

test('deterministic receipt ids are namespaced and bounded', () => {
  const first = createDeterministicReceiptId('runtime-a', 'wake-1');
  const same = createDeterministicReceiptId('runtime-a', 'wake-1');
  const other = createDeterministicReceiptId('runtime-b', 'wake-1');

  assert.equal(first, same);
  assert.equal(first.length, 32);
  assert.notEqual(first, other);
  assert.notEqual(
    createDeterministicReceiptId('a:b', 'c'),
    createDeterministicReceiptId('a', 'b:c'),
  );
  assert.equal(
    createDeterministicReceiptId('runtime-a', 'wake-1', { length: 16 }).length,
    16,
  );
});

test('event source diagnostics normalize readiness without host semantics', () => {
  const diagnostics = summarizeEventSourceStatus([
    { serverId: 'a', events: [{ name: 'one' }, { name: 'two' }] },
    { serverId: 'b', events: [] },
    { serverId: 'c', error: 'offline' },
  ]);

  assert.deepEqual(
    {
      connections: diagnostics.connections,
      eventsCapable: diagnostics.eventsCapable,
      eventDefinitions: diagnostics.eventDefinitions,
      errors: diagnostics.errors,
    },
    {
      connections: 3,
      eventsCapable: 1,
      eventDefinitions: 2,
      errors: 1,
    },
  );
});

test('static one-shot event iterables are snapshotted for repeated refreshes', async () => {
  function* connections() {
    yield {
      connectionId: 'generator-a',
      serverId: 'generator-a',
      request: async () => ({ events: [] }),
      getCapabilities: () => ({
        extensions: { 'io.modelcontextprotocol/events': {} },
      }),
    };
  }

  let capturedOptions;
  const fakeHost = {
    runtime: {},
    eventSources: [],
    async refreshMcpRegistry() { return []; },
    async mcpStatus() { return []; },
    async scope() { return this; },
    async close() {},
  };

  await createEmbeddedRuntimeIntegration({
    eventSources: connections(),
    activation: {
      deliver: ({ receiptId }) => ({ runtimeReceiptId: receiptId }),
    },
    createHost: async (options) => {
      capturedOptions = options;
      return fakeHost;
    },
  });

  const first = [...await capturedOptions.mcpRegistry.listConnections()];
  const second = [...await capturedOptions.mcpRegistry.listConnections()];
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0], second[0]);
});

test('diagnostics retain registry attachment failures', async () => {
  const fakeHost = {
    runtime: {},
    eventSources: [],
    async refreshMcpRegistry() {
      return [{
        connectionId: 'broken-a',
        status: 'error',
        error: 'connection refused',
      }];
    },
    async mcpStatus() { return []; },
    async scope() { return this; },
    async close() {},
  };

  const integration = await createEmbeddedRuntimeIntegration({
    eventSources: [{
      connectionId: 'broken-a',
      serverId: 'broken-a',
      request: async () => ({ events: [] }),
      getCapabilities: () => ({
        extensions: { 'io.modelcontextprotocol/events': {} },
      }),
    }],
    activation: {
      deliver: ({ receiptId }) => ({ runtimeReceiptId: receiptId }),
    },
    createHost: async () => fakeHost,
  });

  const diagnostics = await integration.diagnostics();
  assert.equal(diagnostics.connections, 1);
  assert.equal(diagnostics.errors, 1);
  assert.equal(diagnostics.eventsCapable, 0);
  assert.equal(diagnostics.refreshOutcomes[0].connectionId, 'broken-a');
});

test('embedded binding adapts tools, registers them and wires lifecycle', async () => {
  let closeHook;
  let closed = false;
  const registered = [];
  const integration = {
    tools: [
      { name: 'read' },
      { name: 'write' },
    ],
    async close() {
      closed = true;
    },
  };

  const bound = bindEmbeddedRuntimeIntegration(integration, {
    adapt: (tool) => ({ hostName: `host:${tool.name}` }),
    register: (tool, portableTool) => {
      registered.push([tool.hostName, portableTool.name]);
    },
    onClose: (hook) => {
      closeHook = hook;
    },
  });

  assert.deepEqual(
    bound.map((tool) => tool.hostName),
    ['host:read', 'host:write'],
  );
  assert.deepEqual(registered, [
    ['host:read', 'read'],
    ['host:write', 'write'],
  ]);
  assert.equal(typeof closeHook, 'function');
  await closeHook();
  assert.equal(closed, true);
});

test('runtime integration accepts a static iterable of host-owned event connections', async () => {
  let capturedOptions;
  const connection = {
    connectionId: 'static-a',
    serverId: 'static-a',
    request: async () => ({ events: [] }),
    getCapabilities: () => ({
      extensions: { 'io.modelcontextprotocol/events': {} },
    }),
  };
  const fakeHost = {
    runtime: {},
    eventSources: [],
    async refreshMcpRegistry() { return []; },
    async mcpStatus() {
      return [{ serverId: 'static-a', events: [{ name: 'demo.ready' }] }];
    },
    async scope() { return this; },
    async close() {},
  };

  const integration = await createEmbeddedRuntimeIntegration({
    eventSources: [connection],
    activation: {
      deliver: ({ receiptId }) => ({ runtimeReceiptId: receiptId }),
    },
    createHost: async (options) => {
      capturedOptions = options;
      return fakeHost;
    },
  });

  assert.deepEqual(
    [...await capturedOptions.mcpRegistry.listConnections()],
    [connection],
  );
  const diagnostics = await integration.diagnostics();
  assert.equal(diagnostics.connections, 1);
  assert.equal(diagnostics.eventsCapable, 1);
  assert.equal(diagnostics.eventDefinitions, 1);
});

test('embedded operation registry is the single descriptor source for model tools', () => {
  const keys = [
    'sources', 'create', 'list', 'inspect',
    'pause', 'resume', 'delete', 'update',
  ];
  assert.deepEqual(Object.keys(EMBEDDED_OPERATION_REGISTRY), keys);
  const names = Object.values(EMBEDDED_OPERATION_REGISTRY).map((row) => row.name);
  assert.equal(new Set(names).size, 8);

  const tools = createEventIntelligenceAgentTools({
    host: {},
    resolveContext: () => ({}),
    control: () => ({ action: 'return', result: { ok: false } }),
  });
  for (let i = 0; i < keys.length; i += 1) {
    const canonical = EMBEDDED_OPERATION_REGISTRY[keys[i]];
    assert.equal(tools[i].name, canonical.name);
    assert.equal(tools[i].capability, canonical.capability);
    assert.equal(tools[i].inputSchema, canonical.inputSchema);
    assert.equal(Object.isFrozen(canonical), true);
  }
  const ids = tools.map((tool) => tool.capability.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('embedded tool name collisions cannot shadow a different capability', () => {
  const options = {
    host: {},
    resolveContext: () => ({}),
    control: () => ({ action: 'return', result: { ok: false } }),
  };
  assert.throws(
    () => createEventIntelligenceAgentTools({
      ...options,
      names: { create: 'event_sources_list' },
    }),
    /Duplicate embedded tool name/,
  );
  assert.throws(
    () => createEventIntelligenceAgentTools({
      ...options,
      names: { delete: '' },
    }),
    /non-empty strings/,
  );
  const custom = createEventIntelligenceAgentTools({
    ...options,
    names: { create: 'watch_create', list: 'watch_list' },
  });
  assert.equal(custom[1].name, 'watch_create');
  assert.equal(custom[2].name, 'watch_list');
  assert.equal(custom[1].capability, EMBEDDED_OPERATION_REGISTRY.create.capability);
});

test('embedded exported schema trees are deeply immutable across consumers', () => {
  const create = EMBEDDED_OPERATION_REGISTRY.create.inputSchema;
  const update = EMBEDDED_OPERATION_REGISTRY.update.inputSchema;
  const firstName = create.required[0];
  const eventLength = create.properties.events.items.properties.event.minLength;
  assert.equal(Object.isFrozen(create.required), true);
  assert.equal(Object.isFrozen(create.properties.events.items.properties), true);
  assert.equal(Object.isFrozen(update.properties.events.items.properties), true);
  assert.throws(
    () => create.required.push('dangerous'),
    TypeError,
  );
  assert.throws(
    () => { create.properties.events.items.properties.event.minLength = 999; },
    TypeError,
  );
  assert.throws(
    () => { update.properties.events.items.properties.event.minLength = 999; },
    TypeError,
  );
  assert.equal(create.required[0], firstName);
  assert.equal(create.properties.events.items.properties.event.minLength, eventLength);
});

test('neutral facade delegates to the existing host without taking runtime ownership', async () => {
  let captured;
  let closed = false;
  const fakeHost = {
    runtime: { marker: 'facade' },
    async refreshMcpRegistry() { return []; },
    async mcpStatus() { return []; },
    async scope() { return this; },
    async close() { closed = true; },
    eventSources: [],
  };

  const integration = await createEventIntelligence({
    mcp: {
      list: () => [{ connectionId: 'events-1' }],
    },
    runtime: {
      receiptNamespace: 'test-runtime',
      hasReceipt: () => false,
      deliver: ({ receiptId }) => ({ runtimeReceiptId: receiptId }),
      resolveContext: () => ({
        target: { runtime: 'test-runtime', kind: 'task', id: 'task-1' },
        actor: { type: 'agent', principal_id: 'agent-1' },
        owner: { type: 'user', principal_id: 'owner-1' },
      }),
      control: () => ({ action: 'return', result: { ok: false } }),
    },
    createHost: async (options) => {
      captured = options;
      return fakeHost;
    },
  });

  assert.deepEqual(await captured.mcpRegistry.listConnections(), [
    { connectionId: 'events-1' },
  ]);
  assert.equal(typeof captured.wake, 'function');
  const dispatched = await captured.wake({ wake_id: 'wake-1' }, activation);
  assert.equal(
    dispatched.runtimeReceiptId,
    createDeterministicReceiptId('test-runtime', 'wake-1'),
  );
  assert.equal(integration.tools.length, 8);
  assert.equal(integration.toolCatalog.list().length, 8);
  assert.equal(integration.host, fakeHost);
  await integration.close();
  assert.equal(closed, true);
});

test('neutral facade supports headless delivery without model tools', async () => {
  const fakeHost = {
    runtime: {},
    async refreshMcpRegistry() { return []; },
    async mcpStatus() { return []; },
    async close() {},
  };
  const integration = await createEventIntelligence({
    runtime: {
      deliver: () => ({ runtimeReceiptId: 'receipt-1' }),
    },
    createHost: async () => fakeHost,
  });
  assert.deepEqual(integration.tools, []);
  assert.equal(integration.toolCatalog.all.length, 0);
  await integration.close();
});

test('neutral facade refuses invalid or unguarded host configurations before constructing runtime', async () => {
  let constructed = 0;
  const createHost = async () => {
    constructed += 1;
    throw new Error('should never construct');
  };
  const runtime = { deliver: () => ({ runtimeReceiptId: 'receipt' }) };
  await assert.rejects(
    () => createEventIntelligence({ runtime: {}, createHost }),
    /runtime\.deliver/,
  );
  await assert.rejects(
    () => createEventIntelligence({
      runtime: { ...runtime, resolveContext: () => ({}) },
      createHost,
    }),
    /BOTH runtime\.resolveContext.*runtime\.control/,
  );
  await assert.rejects(
    () => createEventIntelligence({
      runtime: { ...runtime, control: () => ({ action: 'execute' }) },
      createHost,
    }),
    /BOTH runtime\.resolveContext.*runtime\.control/,
  );
  await assert.rejects(
    () => createEventIntelligence({
      mcp: { list: [] },
      runtime,
      createHost,
    }),
    /mcp must provide list/,
  );
  await assert.rejects(
    () => createEventIntelligence({
      runtime: { ...runtime, receiptId: () => 'x', receiptNamespace: 'y' },
      createHost,
    }),
    /receiptId or receiptNamespace/,
  );
  assert.equal(constructed, 0);
});

test('neutral facade preserves class registry receivers for listing and subscription', async () => {
  class HostRegistry {
    constructor() {
      this.connections = [{ connectionId: 'class-registry' }];
      this.listeners = [];
    }
    list() {
      assert.equal(this instanceof HostRegistry, true);
      return this.connections;
    }
    subscribe(listener) {
      assert.equal(this instanceof HostRegistry, true);
      this.listeners.push(listener);
      return () => {
        this.listeners = this.listeners.filter((entry) => entry !== listener);
      };
    }
  }
  const mcp = new HostRegistry();
  let captured;
  const ei = await createEventIntelligence({
    mcp,
    runtime: {
      deliver: () => ({ runtimeReceiptId: 'receipt' }),
    },
    createHost: async (options) => {
      captured = options;
      return {
        runtime: {},
        async refreshMcpRegistry() {},
        async mcpStatus() { return []; },
        async close() {},
      };
    },
  });

  assert.deepEqual(await captured.mcpRegistry.listConnections(), [
    { connectionId: 'class-registry' },
  ]);
  let refreshed = 0;
  const unsub = captured.mcpRegistry.subscribe(() => {
    refreshed += 1;
  });
  assert.equal(mcp.listeners.length, 1);
  mcp.listeners[0]();
  assert.equal(refreshed, 1);
  unsub();
  assert.equal(mcp.listeners.length, 0);
  await ei.close();
});

test('embedded bind filters capability discovery before adapt or register', () => {
  const tools = [
    {
      name: 'event_sources_list',
      capability: EVENT_INTELLIGENCE_CAPABILITIES.eventSourcesList,
    },
    {
      name: 'trigger_create',
      capability: EVENT_INTELLIGENCE_CAPABILITIES.triggerCreate,
    },
    {
      name: 'trigger_delete',
      capability: EVENT_INTELLIGENCE_CAPABILITIES.triggerDelete,
    },
  ];
  const adapted = [];
  const registered = [];
  const integration = {
    tools,
    async close() {},
  };
  const installed = bindEmbeddedRuntimeIntegration(integration, {
    capabilityIds: ['event-intelligence.event-sources.list'],
    adapt(tool) {
      adapted.push(tool.name);
      return { name: tool.name };
    },
    register(hostTool) {
      registered.push(hostTool.name);
    },
  });
  assert.deepEqual(installed, [{ name: 'event_sources_list' }]);
  assert.deepEqual(adapted, ['event_sources_list']);
  assert.deepEqual(registered, ['event_sources_list']);

  const none = bindEmbeddedRuntimeIntegration(integration, {
    capabilityIds: [],
    adapt() { throw new Error('must not adapt'); },
    register() { throw new Error('must not register'); },
  });
  assert.deepEqual(none, []);
});

test('unknown or malformed capability allowlists fail before any registration', () => {
  let registrations = 0;
  const integration = {
    tools: [{
      name: 'event_sources_list',
      capability: EVENT_INTELLIGENCE_CAPABILITIES.eventSourcesList,
    }],
    async close() {},
  };
  for (const capabilityIds of [
    ['event-intelligence.trigger.delete'],
    ['event-intelligence.event-sources.list', 'unknown'],
    'event-intelligence.event-sources.list',
    [null],
  ]) {
    assert.throws(
      () => bindEmbeddedRuntimeIntegration(integration, {
        capabilityIds,
        adapt: () => ({ name: 'never' }),
        register: () => { registrations++; },
      }),
      /capabilityIds must|unknown EI capability/,
    );
  }
  assert.equal(registrations, 0);
});
