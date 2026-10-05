import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EVENT_INTELLIGENCE_CAPABILITIES,
  bindEmbeddedRuntimeIntegration,
  createActivationDispatcher,
  createDeterministicReceiptId,
  createContinuationTarget,
  createEmbeddedEventIntelligence,
  createEmbeddedRuntimeIntegration,
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
