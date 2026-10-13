import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventIntelligenceHost } from '../scripts/host-integration.mjs';
import {
  McpEventsClientManager,
  isUnavailableCapability,
} from '../scripts/lib/mcp-events-client.mjs';
import { createObservabilityEmitter } from '../scripts/lib/observability.mjs';

const PROBE = 'arbitrary-unlabelled-private-data-canary';
const BEARER = 'Bearer eyJhbGciOiJiZW90aWNfYXBpX2tleSJ9.secret';
const unsafe = 'provider-failure: ' + PROBE + ' authorization=' + BEARER;
const SAFE = 'MCP Events provider operation failed';

function fixture({
  request, getCapabilities, openEventStream, delivery = 'poll',
} = {}) {
  const observations = [];
  const descriptor = {
    name: 'private.event',
    delivery: [delivery],
    inputSchema: { type: 'object' },
    payloadSchema: { type: 'object' },
  };
  const store = {
    async listTriggers() {
      return [{
        triggerId: 'private-trigger',
        version: '1',
        clauses: [{
          id: 'private',
          event: descriptor.name,
          serverId: 'source-server',
          arguments: {},
        }],
      }];
    },
    async getTriggerState() { return { status: 'active' }; },
    async getMcpClientState() { return null; },
    async listMcpClientStates() { return []; },
    async putMcpClientState(value) { return value; },
  };
  const manager = new McpEventsClientManager({
    store,
    compositeEventConsumer: { async ingestMcpOccurrence() {} },
    registerEventSource: async () => {},
    observability: createObservabilityEmitter({
      emit(record) { observations.push(record); },
    }),
  });
  const connection = manager.addConnection({
    connectionId: 'source-connection',
    serverId: 'source-server',
    request: request ?? (async () => ({ events: [] })),
    getCapabilities: getCapabilities ?? (async () => ({
      extensions: { 'io.modelcontextprotocol/events': { listChanged: false } },
    })),
    ...(openEventStream ? { openEventStream } : {}),
  });
  manager.descriptors.set(connection.connectionId, [descriptor]);
  manager.profiles.set(connection.connectionId, { pollMethod: 'events/poll' });
  const subscription = {
    subscriptionId: 'subscription',
    eventName: descriptor.name,
    arguments: {},
    descriptor,
    consumerRefs: ['private-trigger@1:private'],
  };
  const assertNoSecret = value => {
    const serialized = JSON.stringify(value);
    assert.doesNotMatch(serialized, /arbitrary-unlabelled-private-data-canary/);
    assert.doesNotMatch(serialized, /eyJhbGciOiJiZW90aWNfYXBpX2tleSJ9/);
  };
  return { manager, connection, store, subscription, observations, assertNoSecret };
}

test('untrusted events/list exception does not reach discoverAll or status', async () => {
  for (const thrown of [new Error(unsafe), unsafe]) {
    const f = fixture({
      request: async () => { throw thrown; },
    });
    const discovery = await f.manager.discoverAll();
    assert.equal(discovery[0].status, 'error');
    assert.equal(discovery[0].error, SAFE);
    f.assertNoSecret(discovery);
    const status = await f.manager.status();
    assert.equal(status[0].error, SAFE);
    f.assertNoSecret(status);
  }
});

test('provider poll failure returns fixed status without raw payload or telemetry leakage', async () => {
  const f = fixture({
    request: async () => { throw new Error(unsafe); },
  });
  const outcomes = await f.manager.pollAll();
  assert.equal(outcomes[0].error, SAFE);
  assert.equal((await f.manager.status())[0].error, SAFE);
  assert.equal(f.observations[0]?.event, 'ei.source.poll_failed');
  assert.equal(f.observations[0]?.error?.message, SAFE);
  f.assertNoSecret({ outcomes, status: await f.manager.status(),
    telemetry: f.observations });
});

test('push error and termination callbacks cannot publish arbitrary provider diagnostics', async () => {
  let callbacks;
  const f = fixture({
    delivery: 'push',
    openEventStream: async args => {
      callbacks = args;
      return { async close() {} };
    },
  });
  const context = await f.manager.scopeContext(f.connection);
  assert.equal((await f.manager.ensureDeliverySession(
    f.connection, context, f.subscription, 'push',
  )).status, 'active');
  callbacks.onError(new Error(unsafe));
  assert.equal((await f.manager.status())[0].error, SAFE);
  f.assertNoSecret(f.observations);
  assert.equal(f.observations.at(-1)?.error?.message, SAFE);
  let getterCalls = 0;
  const hostileDetail = {};
  Object.defineProperty(hostileDetail, 'message', {
    enumerable: true,
    get() { getterCalls++; throw new Error('must not stringify'); },
  });
  await callbacks.onTerminated(hostileDetail);
  assert.equal(getterCalls, 0);
  assert.equal((await f.manager.status())[0].error, SAFE);
  f.assertNoSecret({ telemetry: f.observations,
    status: await f.manager.status() });
});

test('registry attach error does not expose producer-controlled exception or telemetry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ei-safe-registry-error-'));
  const observations = [];
  let entries = [];
  let host;
  try {
    host = await createEventIntelligenceHost({
      dataDir: directory,
      env: {
        TYPESAFE_API_KEY: '',
        RUNTIME_WAKE_TARGETS_JSON: '{}',
        TEMPORAL_TICK_MS: '100000',
        WAKE_RETRY_TICK_MS: '100000',
      },
      mcpRegistry: { listConnections: () => entries },
      observability: record => observations.push(record),
    });
    entries = [{
      id: 'source-connection',
      serverId: 'source-server',
      pollIntervalMs: 300000,
      client: {
        getServerCapabilities: () => ({
          extensions: {
            'io.modelcontextprotocol/events': { listChanged: false },
          },
        }),
        async request() { throw new Error(unsafe); },
      },
    }];
    const result = await host.refreshMcpRegistry();
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'error');
    assert.equal(result[0].code, 'EI_HOST_REGISTRY_ATTACH_FAILED');
    assert.equal(result[0].error, 'MCP registry connection attach failed');
    const serialized = JSON.stringify({
      outcome: result,
      telemetry: observations,
    });
    assert.doesNotMatch(serialized, /arbitrary-unlabelled-private-data-canary/);
    assert.doesNotMatch(serialized, /eyJhbGciOiJiZW90aWNfYXBpX2tleSJ9/);
  } finally {
    await host?.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test('capability lookup errors are neutralized before public attach and discover', async () => {
  const f = fixture({
    getCapabilities: async () => { throw new Error(unsafe); },
  });
  await assert.rejects(
    f.manager.discoverConnection(f.connection.connectionId),
    error => {
      assert.equal(error.message, SAFE);
      assert.equal(error.code, 'MCP_EVENTS_PROVIDER_REQUEST_FAILED');
      f.assertNoSecret({ error: error.message });
      return true;
    },
  );
  const discovered = await f.manager.discoverAll();
  assert.equal(discovered[0].status, 'error');
  assert.equal(discovered[0].error, SAFE);
  f.assertNoSecret(discovered);
});

test('push provider opening failure never escapes as raw provider exception', async () => {
  for (const openError of [new Error(unsafe), unsafe]) {
    const f = fixture({
      delivery: 'push',
      openEventStream: async () => { throw openError; },
    });
    const context = await f.manager.scopeContext(f.connection);
    await assert.rejects(
      f.manager.ensureDeliverySession(f.connection, context, f.subscription, 'push'),
      error => {
        assert.equal(error.message, SAFE);
        assert.equal(error.code, 'MCP_EVENTS_PROVIDER_REQUEST_FAILED');
        f.assertNoSecret({ error: error.message });
        return true;
      },
    );
  }
});

test('capability-unavailable classification never invokes an accessor or Proxy trap', () => {
  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'code', {
    enumerable: true,
    get() {
      reads++;
      throw new Error(unsafe);
    },
  });
  assert.equal(isUnavailableCapability(hostile), false);
  const proxy = new Proxy({}, {
    get() { reads++; throw new Error(unsafe); },
    getOwnPropertyDescriptor() { reads++; throw new Error(unsafe); },
  });
  assert.equal(isUnavailableCapability(proxy), false);
  assert.equal(reads, 0);
  const safe = Object.assign(new Error('capability unavailable'), {
    code: 'MCP_EVENTS_CAPABILITY_UNAVAILABLE',
  });
  assert.equal(isUnavailableCapability(safe), true);
});

test('host registry attaches classify getter-bearing provider errors safely', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ei-registry-accessor-error-'));
  let host;
  let getterReads = 0;
  try {
    let entries = [];
    host = await createEventIntelligenceHost({
      dataDir: directory,
      env: {
        TYPESAFE_API_KEY: '',
        RUNTIME_WAKE_TARGETS_JSON: '{}',
        TEMPORAL_TICK_MS: '100000',
        WAKE_RETRY_TICK_MS: '100000',
      },
      mcpRegistry: { listConnections: () => entries },
    });
    entries = [{
      id: 'provider-error-code',
      serverId: 'source-server',
      client: {
        getServerCapabilities() {
          const error = new Error(unsafe);
          Object.defineProperty(error, 'code', {
            get() { getterReads++; throw new Error(unsafe); },
          });
          throw error;
        },
        async request() { return { events: [] }; },
      },
    }];
    const results = await host.refreshMcpRegistry();
    assert.equal(results[0]?.status, 'error');
    assert.equal(results[0]?.code, 'EI_HOST_REGISTRY_ATTACH_FAILED');
    assert.equal(results[0]?.error, 'MCP registry connection attach failed');
    assert.equal(getterReads, 0);
    assert.doesNotMatch(JSON.stringify(results), /arbitrary-unlabelled-private-data-canary/);
  } finally {
    await host?.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test('fulfilled getter-backed capability objects cannot execute accessors or disclose exceptions', async () => {
  for (const field of ['extensions', 'declaredExtension']) {
    let getterInvocations = 0;
    const extensions = {};
    Object.defineProperty(extensions, 'io.modelcontextprotocol/events', {
      enumerable: true,
      get() { getterInvocations++; throw new Error(unsafe); },
    });
    const capabilities = field === 'extensions'
      ? Object.defineProperty({}, 'extensions', {
          enumerable: true,
          get() { getterInvocations++; throw new Error(unsafe); },
        })
      : { extensions };
    const f = fixture({
      getCapabilities: async () => capabilities,
    });
    await assert.rejects(
      f.manager.discoverConnection(f.connection.connectionId),
      error => {
        assert.equal(error.message, SAFE);
        assert.equal(error.code, 'MCP_EVENTS_PROVIDER_REQUEST_FAILED');
        return true;
      },
    );
    assert.equal(getterInvocations, 0,
      field + ' accessor must never be evaluated');
  }
});

test('fulfilled poll-page top-level accessors fail before cursor or payload processing', async () => {
  for (const field of ['events', 'cursor', 'hasMore', 'truncated', 'nextPollMs']) {
    let getterInvocations = 0;
    const raw = {
      events: [],
      cursor: 'safe-cursor',
      hasMore: false,
      truncated: false,
      nextPollMs: 1000,
    };
    Object.defineProperty(raw, field, {
      enumerable: true,
      get() { getterInvocations++; throw new Error(unsafe); },
    });
    const f = fixture({ request: async () => raw });
    await assert.rejects(
      f.manager.pollConnection(f.connection.connectionId),
      error => {
        assert.equal(error.code, 'MCP_EVENTS_POLL_PAGE_INVALID');
        assert.equal(error.message, 'MCP Events poll page is unsafe');
        f.assertNoSecret({ message: error.message, code: error.code });
        return true;
      },
    );
    assert.equal(getterInvocations, 0,
      field + ' getter must not run during poll page validation');
    assert.equal(f.observations.length, 0);
  }
});

test('fulfilled capability/poll proxies are rejected without invoking provider fields', async () => {
  let capabilityTrap = 0;
  const badCapabilities = new Proxy({}, {
    get(_target, key) {
      if (key !== 'then') capabilityTrap++;
      return undefined;
    },
    getOwnPropertyDescriptor() {
      capabilityTrap++;
      throw new Error(unsafe);
    },
  });
  const cap = fixture({ getCapabilities: async () => badCapabilities });
  await assert.rejects(
    cap.manager.discoverConnection(cap.connection.connectionId),
    error => error.message === SAFE,
  );
  assert.equal(capabilityTrap, 0);

  let eventPropertyReads = 0;
  const badPage = new Proxy({}, {
    get(_target, key) {
      if (key === 'events') eventPropertyReads++;
      return undefined;
    },
    getOwnPropertyDescriptor() {
      eventPropertyReads++;
      throw new Error(unsafe);
    },
  });
  const poll = fixture({ request: async () => badPage });
  await assert.rejects(
    poll.manager.pollConnection(poll.connection.connectionId),
    error => error.code === 'MCP_EVENTS_POLL_PAGE_INVALID',
  );
  assert.equal(eventPropertyReads, 0,
    'proxy gets only unavoidable Promise thenable assimilation, no page field reads');
});


test('nextPollMs object coercion cannot run provider valueOf or leak secrets', async () => {
  let calls = 0;
  const fakeNumber = {
    valueOf() { calls++; throw new Error(unsafe); },
    toString() { calls++; throw new Error(unsafe); },
  };
  const f = fixture({
    request: async () => ({
      events: [],
      cursor: null,
      hasMore: false,
      nextPollMs: fakeNumber,
    }),
  });
  await assert.rejects(
    f.manager.pollConnection(f.connection.connectionId),
    error => {
      assert.equal(error.message, 'events/poll returned invalid nextPollMs');
      f.assertNoSecret({ code: error.code ?? null, message: error.message });
      return true;
    },
  );
  assert.equal(calls, 0, 'numeric delay parsing must not invoke provider methods');
});
