import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createEventIntelligenceHost,
  PersistentEventStore,
} from '../scripts/host-integration.mjs';

const env = {
  TYPESAFE_API_KEY: '',
  RUNTIME_WAKE_TARGETS_JSON: '{}',
  TEMPORAL_TICK_MS: '100000',
  WAKE_RETRY_TICK_MS: '100000',
};

test('registry subscribe startup failure closes the initialized host/store', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-registry-init-'));
  const store = new PersistentEventStore(dataDir);
  let closeCalls = 0;
  const originalClose = store.close.bind(store);
  store.close = async () => {
    closeCalls++;
    return originalClose();
  };
  let listed = 0;
  const failure = new Error('host registry subscription initialization failed');
  try {
    await assert.rejects(createEventIntelligenceHost({
      dataDir,
      env,
      store,
      mcpRegistry: {
        listConnections() { listed++; return []; },
        subscribe() { throw failure; },
      },
    }), error => error === failure);
    assert.equal(listed, 1);
    assert.equal(closeCalls, 1,
      'failed subscribe must release the already-started durable runtime');
  } finally {
    await originalClose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('close synchronously fences stale registry notifications and manual attachment', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-registry-close-'));
  let host;
  let onChange;
  let listCalls = 0;
  let unsubscribed = 0;
  try {
    host = await createEventIntelligenceHost({
      dataDir,
      env,
      mcpRegistry: {
        listConnections() { listCalls++; return []; },
        subscribe(listener) {
          onChange = listener;
          return () => { unsubscribed++; };
        },
      },
    });
    assert.equal(listCalls, 1);
    assert.equal(typeof onChange, 'function');
    // A host can retain tenant views before root shutdown. Those views
    // must not retain authority to reattach after the root is closing.
    const scoped = await host.scope('tenant-a');
    const first = host.close();
    const second = host.close();
    assert.equal(first, second, 'concurrent closing shares the same promise');
    onChange();
    onChange();
    await assert.rejects(host.refreshMcpRegistry(), error =>
      error?.code === 'EI_HOST_CLOSED');
    await assert.rejects(host.attachMcpClient({ id: 'late', serverId: 'late' }),
      error => error?.code === 'EI_HOST_CLOSED');
    await assert.rejects(scoped.attachMcpClient({ id: 'late-scoped', serverId: 'late' }),
      error => error?.code === 'EI_HOST_CLOSED',
      'an already acquired tenant view cannot bypass the shutdown fence');
    await assert.rejects(host.scope('new-tenant'),
      error => error?.code === 'EI_HOST_CLOSED');
    await Promise.all([first, second, host.close()]);
    assert.equal(unsubscribed, 1);
    assert.equal(listCalls, 1, 'no post-close registry refresh may run');
  } finally {
    await host?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('host close drains in-flight registry enumeration but ignores the late result', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-registry-drain-'));
  let host;
  let listCalls = 0;
  let signalEntered;
  let finishEnumeration;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  const enumeration = new Promise(resolve => { finishEnumeration = resolve; });
  try {
    host = await createEventIntelligenceHost({
      dataDir,
      env,
      mcpRegistry: {
        listConnections: () => {
          listCalls++;
          if (listCalls !== 2) return [];
          signalEntered();
          return enumeration;
        },
      },
    });
    const inFlight = host.refreshMcpRegistry();
    await entered;
    let closed = false;
    const close = host.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false,
      'closing host must not tear down store beneath a pending refresh');
    finishEnumeration([{
      connectionId: 'late-discovery', serverId: 'upstream',
      request: async () => ({ events: [] }),
      getCapabilities: () => ({ extensions: {
        'io.modelcontextprotocol/events': {},
      } }),
    }]);
    assert.deepEqual(await inFlight, []);
    await close;
    assert.equal(closed, true);
    assert.equal(listCalls, 2);
    assert.deepEqual(await host.mcpStatus(), [],
      'late enumeration must not attach a connection after the close fence');
  } finally {
    finishEnumeration?.([]);
    await host?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('retained public MCP manager rejects post-close actions and drains pre-close attachment', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-manager-close-'));
  let host;
  let ready;
  let releaseCapabilities;
  const entered = new Promise(resolve => { ready = resolve; });
  const capabilities = new Promise(resolve => { releaseCapabilities = resolve; });
  let listRequests = 0;
  try {
    host = await createEventIntelligenceHost({ dataDir, env });
    const retainedManager = host.runtime.mcpEventsClient;
    const attach = host.attachMcpClient({
      id: 'accepted-before-close', serverId: 'manual-upstream',
      getCapabilities() {
        ready();
        return capabilities;
      },
      async request() {
        listRequests++;
        return { events: [], cursor: null };
      },
    });
    await entered;
    let closed = false;
    const shutdown = host.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false,
      'accepted asynchronous provider discovery must drain before store close');
    releaseCapabilities({ extensions: {
      'io.modelcontextprotocol/events': { listChanged: false },
    } });
    await assert.rejects(attach, error => error?.code === 'EI_HOST_CLOSED');
    await shutdown;
    assert.equal(closed, true);
    assert.equal(listRequests, 0,
      'provider listing must not restart after the manager is closed');
    const lateConnection = {
      connectionId: 'late-manager', serverId: 'manual-upstream',
      getCapabilities: () => ({ extensions: {
        'io.modelcontextprotocol/events': {},
      } }),
      request: async () => { listRequests++; return { events: [] }; },
    };
    assert.throws(() => retainedManager.addConnection(lateConnection),
      error => error?.code === 'EI_HOST_CLOSED');
    await assert.rejects(retainedManager.attachConnection(lateConnection),
      error => error?.code === 'EI_HOST_CLOSED');
    await assert.rejects(retainedManager.pollConnection('accepted-before-close'),
      error => error?.code === 'EI_HOST_CLOSED');
    await assert.rejects(retainedManager.discoverConnection('accepted-before-close'),
      error => error?.code === 'EI_HOST_CLOSED');
    assert.equal(listRequests, 0);
  } finally {
    releaseCapabilities?.({ extensions: {} });
    await host?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
