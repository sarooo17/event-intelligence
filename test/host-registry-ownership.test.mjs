import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEventIntelligenceHost } from '../scripts/host-integration.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';

function eventsClient(eventName) {
  return {
    getServerCapabilities() {
      return {
        extensions: {
          'io.modelcontextprotocol/events': { listChanged: false },
        },
      };
    },
    async request(message) {
      if (message.method === 'events/list') {
        return {
          events: [{
            name: eventName,
            delivery: ['poll'],
            payloadSchema: { type: 'object' },
          }],
        };
      }
      if (message.method === 'events/poll') {
        return { events: [], cursor: 'ready', hasMore: false };
      }
      throw new Error('Unexpected Events request: ' + message.method);
    },
  };
}

const env = {
  TYPESAFE_API_KEY: '',
  RUNTIME_WAKE_TARGETS_JSON: '{}',
  TEMPORAL_TICK_MS: '100000',
  WAKE_RETRY_TICK_MS: '100000',
};

const names = async host =>
  (await host.eventSources).map(source => source.eventName).sort();

test('registry cannot adopt, replace or detach an explicitly declared MCP client', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-registry-owned-'));
  const hostClient = eventsClient('explicit.changed');
  let registryEntries = [{
    id: 'owned',
    serverId: 'host-server',
    client: hostClient,
    pollIntervalMs: 300000,
  }];
  const registry = { listConnections: () => registryEntries };
  let host;
  try {
    host = await createEventIntelligenceHost({
      dataDir,
      env,
      mcpClients: [{
        id: 'owned',
        serverId: 'host-server',
        client: hostClient,
        pollIntervalMs: 300000,
      }],
      mcpRegistry: registry,
    });

    // Even the same client / server identity may not be adopted by the
    // registry. The initial startup refresh must leave ownership with host.
    const repeated = await host.refreshMcpRegistry();
    assert.deepEqual(repeated.map(result => ({
      id: result.connectionId, status: result.status, code: result.code,
    })), [{
      id: 'owned',
      status: 'error',
      code: 'EI_HOST_REGISTRY_ID_CONFLICT',
    }]);
    assert.deepEqual(await names(host), ['explicit.changed']);
    assert.deepEqual((await host.mcpStatus()).map(row => row.connectionId), ['owned']);

    // A different identity must never replace the explicit provider, while
    // an unrelated registry entry must still attach normally.
    registryEntries = [
      {
        id: 'owned',
        serverId: 'attempted-replacement',
        client: eventsClient('unauthorized.changed'),
        pollIntervalMs: 300000,
      },
      {
        id: 'registry-only',
        serverId: 'registry-server',
        client: eventsClient('registry.changed'),
        pollIntervalMs: 300000,
      },
    ];
    const changed = await host.refreshMcpRegistry();
    assert.ok(changed.some(row =>
      row.connectionId === 'owned' &&
      row.status === 'error' &&
      row.code === 'EI_HOST_REGISTRY_ID_CONFLICT'));
    assert.ok(changed.some(row =>
      row.connectionId === 'registry-only' && row.status === 'attached'));
    assert.deepEqual(await names(host), ['explicit.changed', 'registry.changed']);

    registryEntries = [];
    const removed = await host.refreshMcpRegistry();
    assert.ok(removed.some(row =>
      row.connectionId === 'registry-only' && row.status === 'detached'));
    assert.equal(removed.some(row => row.connectionId === 'owned'), false,
      'registry removal must not detach host-owned connections');
    assert.deepEqual((await host.mcpStatus()).map(row => row.connectionId), ['owned']);
    assert.deepEqual(await names(host), ['explicit.changed']);
  } finally {
    await host?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('manual host client attachment remains protected from later registry collisions', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-registry-manual-'));
  let registryEntries = [];
  let host;
  try {
    host = await createEventIntelligenceHost({
      dataDir,
      env,
      mcpRegistry: { listConnections: () => registryEntries },
    });
    await host.attachMcpClient({
      id: 'manually-owned',
      serverId: 'manual-server',
      client: eventsClient('manual.changed'),
      pollIntervalMs: 300000,
    });
    registryEntries = [{
      id: 'manually-owned',
      serverId: 'conflicting-server',
      client: eventsClient('replaced.changed'),
      pollIntervalMs: 300000,
    }];
    const results = await host.refreshMcpRegistry();
    assert.equal(results.length, 1);
    assert.equal(results[0].code, 'EI_HOST_REGISTRY_ID_CONFLICT');
    assert.equal(results[0].status, 'error');
    assert.deepEqual(await names(host), ['manual.changed']);

    registryEntries = [];
    await host.refreshMcpRegistry();
    assert.deepEqual(await names(host), ['manual.changed']);
    assert.deepEqual((await host.mcpStatus()).map(row => row.connectionId),
      ['manually-owned']);
  } finally {
    await host?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});


test('registry refresh cannot detach a host replacement inserted during awaited cleanup', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-registry-aba-'));
  let registryEntries = [{
    id: 'shared',
    serverId: 'registry-v1',
    client: eventsClient('registry.v1'),
    pollIntervalMs: 300000,
  }];
  let host;
  let releaseDetach;
  let detachedResolve;
  const detached = new Promise(resolve => { detachedResolve = resolve; });
  const detachGate = new Promise(resolve => { releaseDetach = resolve; });
  try {
    host = await createEventIntelligenceHost({
      dataDir,
      env,
      mcpRegistry: { listConnections: () => registryEntries },
    });
    assert.deepEqual(await names(host), ['registry.v1']);
    const client = host.runtime.mcpEventsClient;
    const actualDetach = client.detachConnection.bind(client);
    let intercepted = false;
    client.detachConnection = async connectionId => {
      const result = await actualDetach(connectionId);
      if (connectionId === 'shared' && !intercepted) {
        intercepted = true;
        detachedResolve();
        await detachGate;
      }
      return result;
    };

    registryEntries = [{
      id: 'shared',
      serverId: 'registry-v2',
      client: eventsClient('registry.v2'),
      pollIntervalMs: 300000,
    }];
    const refreshing = host.refreshMcpRegistry();
    await detached;
    // The old registry connection is physically gone and cleanup completed,
    // but its refresh still awaits. The host takes the now-vacant ID.
    await host.attachMcpClient({
      id: 'shared',
      serverId: 'host-replacement',
      client: eventsClient('host.replacement'),
      pollIntervalMs: 300000,
    });
    releaseDetach();
    const results = await refreshing;
    assert.ok(results.some(result =>
      result.connectionId === 'shared' &&
      result.status === 'error' &&
      result.code === 'EI_HOST_REGISTRY_ID_CONFLICT'));
    assert.deepEqual(await names(host), ['host.replacement']);
    assert.deepEqual((await host.mcpStatus()).map(entry => entry.serverId),
      ['host-replacement']);

    registryEntries = [];
    await host.refreshMcpRegistry();
    assert.deepEqual(await names(host), ['host.replacement'],
      'subsequent registry removal must not revoke the new host owner');
  } finally {
    releaseDetach?.();
    await host?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});


test('failed asynchronous registry cleanup cannot retain ownership of a new host client', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-registry-cleanup-fail-'));
  let entries = [{
    id: 'shared',
    serverId: 'old-registry',
    client: eventsClient('registry.old'),
    pollIntervalMs: 300000,
  }];
  let host;
  let detachReached;
  const detached = new Promise(resolve => { detachReached = resolve; });
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  try {
    host = await createEventIntelligenceHost({
      dataDir,
      env,
      mcpRegistry: { listConnections: () => entries },
    });
    const manager = host.runtime.mcpEventsClient;
    const originalDetach = manager.detachConnection.bind(manager);
    let intercepted = false;
    manager.detachConnection = async id => {
      await originalDetach(id);
      if (id === 'shared' && !intercepted) {
        intercepted = true;
        detachReached();
        await gate;
        // Simulate an asynchronous cleanup failure AFTER the original
        // connection has been removed. Reconciliation must not leave an
        // ownership marker that could revoke a newer host connection.
        throw new Error('injected detached-store cleanup failure');
      }
      return true;
    };

    entries = [{
      id: 'shared',
      serverId: 'new-registry',
      client: eventsClient('registry.new'),
      pollIntervalMs: 300000,
    }];
    const refreshing = host.refreshMcpRegistry();
    await detached;
    await host.attachMcpClient({
      id: 'shared',
      serverId: 'new-host',
      client: eventsClient('host.new'),
      pollIntervalMs: 300000,
    });
    unblock();
    const outcomes = await refreshing;
    assert.ok(outcomes.some(result =>
      result.connectionId === 'shared' &&
      result.status === 'error' &&
      result.code === 'EI_HOST_REGISTRY_DETACH_FAILED'));
    assert.deepEqual(await names(host), ['host.new']);

    // If stale registryManaged ownership survived the failed await, this
    // removal refresh would mistakenly detach the host's replacement.
    entries = [];
    const next = await host.refreshMcpRegistry();
    assert.equal(next.some(result => result.connectionId === 'shared'), false);
    assert.deepEqual(await names(host), ['host.new']);
    assert.deepEqual((await host.mcpStatus()).map(row => row.serverId), ['new-host']);
  } finally {
    unblock?.();
    await host?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});


test('registry rotates host authority epoch on same MCP client identity',async()=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'ei-registry-epoch-'));
  const store=new PersistentEventStore(dataDir);
  store.requireMcpSessionFence=true;
  const begin=[],revoke=[];
  store.beginMcpConnectionAuthority=async x=>{begin.push(x);return {active:true}};
  store.revokeMcpConnectionAuthority=async x=>{revoke.push(x);return true};
  const provider=eventsClient('epoch.changed');
  const a='epoch-a'.padEnd(48,'a'),b='epoch-b'.padEnd(48,'b');
  let registryEntries=[{
    id:'rotate',serverId:'server',client:provider,
    authorityEpoch:a,pollIntervalMs:300000,
  }];
  let host;
  try{
    host=await createEventIntelligenceHost({
      store,env,mcpRegistry:{listConnections:()=>registryEntries},
    });
    assert.deepEqual(begin.map(x=>x.epoch),[a]);
    registryEntries=[{...registryEntries[0],authorityEpoch:b}];
    const result=await host.refreshMcpRegistry();
    assert.ok(result.some(x=>x.status==='reattached'));
    assert.deepEqual(revoke.map(x=>x.epoch),[a]);
    assert.deepEqual(begin.map(x=>x.epoch),[a,b]);
    assert.equal(host.runtime.mcpEventsClient.connections.get('rotate').authorityEpoch,b);
  }finally{
    await host?.close();
    await rm(dataDir,{recursive:true,force:true});
  }
});
