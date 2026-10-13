import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventIntelligenceHost } from '../scripts/host-integration.mjs';
import { McpEventsClientManager } from '../scripts/lib/mcp-events-client.mjs';
import { createObservabilityEmitter } from '../scripts/lib/observability.mjs';

const PROBE = 'arbitrary-unlabelled-private-data-canary';
const BEARER = 'Bearer eyJhbGciOiJiZW90aWNfYXBpX2tleSJ9.secret';
const unsafe = 'provider-failure: ' + PROBE + ' authorization=' + BEARER;
const SAFE = 'MCP Events provider operation failed';

function fixture({ request, openEventStream, delivery = 'poll' } = {}) {
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
    getCapabilities: async () => ({
      extensions: { 'io.modelcontextprotocol/events': { listChanged: false } },
    }),
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
