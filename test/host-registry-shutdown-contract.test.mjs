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
    const retained = host.runtime.mcpEventsClient;
    const first = host.close();
    // No microtask/yield between root host close and raw manager access.
    // This is precisely the previously identified retained-runtime bypass.
    assert.throws(() => retained.addConnection({
      connectionId: 'same-turn-attach', serverId: 'upstream',
    }), error => error?.code === 'EI_HOST_CLOSED');
    await assert.rejects(retained.attachConnection({
      connectionId: 'same-turn-attach', serverId: 'upstream',
    }), error => error?.code === 'EI_HOST_CLOSED');
    const second = host.close();
    assert.equal(first, second, 'concurrent closing shares the same promise');
    onChange();
    onChange();
    await assert.rejects(host.refreshMcpRegistry(), error =>
      error?.code === 'EI_HOST_CLOSED');
    await assert.rejects(host.attachMcpClient({ id: 'late', serverId: 'late' }),
      error => error?.code === 'EI_HOST_CLOSED');
    await assert.rejects(host.detachMcpClient('same-turn-attach'),
      error => error?.code === 'EI_HOST_CLOSED');
    await assert.rejects(retained.detachConnection('same-turn-attach'),
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

test('registry unsubscribe synchronous reentrancy reuses the already-published close promise', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-reentrant-close-'));
  let host;
  let nested;
  let unsubscribeCalls = 0;
  try {
    host = await createEventIntelligenceHost({
      dataDir, env,
      mcpRegistry: {
        listConnections: () => [],
        subscribe: () => () => {
          unsubscribeCalls++;
          nested = host.close();
        },
      },
    });
    const outer = host.close();
    await outer;
    assert.equal(nested, outer,
      'reentrant close during an unsubscribe callback must reuse original promise');
    assert.equal(unsubscribeCalls, 1,
      'reentrant close must not invoke unsubscribe twice');
    assert.equal(host.close(), outer);
  } finally {
    await host?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('provider close hook awaiting host.close cannot deadlock shutdown', { timeout: 10000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-provider-reentrant-close-'));
  let host;
  try {
    host = await createEventIntelligenceHost({ dataDir, env });
    const manager = host.runtime.mcpEventsClient;
    let teardownCalls = 0;
    let nestedClose;
    // Simulate the close() contract of a push/webhook handle whose host-
    // owned teardown waits for global host shutdown. The manager's session
    // registry is the exact list consumed by manager.stop().
    manager.deliverySessions.set('provider-session', {
      close() {
        teardownCalls++;
        nestedClose = host.close();
        return nestedClose;
      },
    });
    const closing = host.close();
    let timer;
    await Promise.race([
      closing,
      new Promise((_, reject) => {
        timer = setTimeout(() =>
          reject(new Error('provider teardown created a host.close cycle')), 2500);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(teardownCalls, 1);
    assert.equal(nestedClose, closing,
      'provider reentrant close must reuse published host close promise');
    assert.equal(host.close(), closing);
    assert.equal(manager.deliverySessions.size, 0);
  } finally {
    await host?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});


test('close waits for a pre-accepted manual detach but rejects any new detach', {
  timeout: 10000,
}, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-detach-drain-'));
  let host;
  let release;
  const held=new Promise(resolve=>{release=resolve});
  let signal;
  const entered=new Promise(resolve=>{signal=resolve});
  try {
    host=await createEventIntelligenceHost({dataDir,env});
    const manager=host.runtime.mcpEventsClient;
    manager.addConnection({
      connectionId:'manual-detach',serverId:'upstream',
      getCapabilities:()=>({extensions:{'io.modelcontextprotocol/events':{}}}),
      request:async()=>({events:[]}),
    });
    const original=manager.scopeContext.bind(manager);
    manager.scopeContext=async connection=>{
      const context=await original(connection);
      return {
        ...context,
        store:{
          listEventSources:async()=>{
            signal();
            return held;
          },
        },
      };
    };
    const detach=host.detachMcpClient('manual-detach');
    await entered;
    let finished=false;
    const closing=host.close().then(()=>{finished=true});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(finished,false,
      'host cannot tear down storage during an accepted source-disable operation');
    await assert.rejects(host.detachMcpClient('manual-detach'),
      error=>error?.code==='EI_HOST_CLOSED');
    await assert.rejects(manager.detachConnection('manual-detach'),
      error=>error?.code==='EI_HOST_CLOSED');
    release([]);
    await Promise.all([detach,closing]);
    assert.equal(finished,true);
    assert.equal(manager.detachInFlight.size,0);
    assert.equal(manager.connections.has('manual-detach'),false);
  }finally{
    release?.([]);
    await host?.close();
    await rm(dataDir,{recursive:true,force:true});
  }
});


test('reentrant detach session cannot hold host shutdown in a promise cycle', {
  timeout: 10000,
}, async()=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'ei-detach-reentrant-'));
  let host;
  try {
    host=await createEventIntelligenceHost({dataDir,env});
    const manager=host.runtime.mcpEventsClient;
    manager.addConnection({
      connectionId:'detach-with-session',serverId:'upstream',
      getCapabilities:()=>({extensions:{'io.modelcontextprotocol/events':{}}}),
      request:async()=>({events:[]}),
    });
    const connection=manager.connections.get('detach-with-session');
    let reentrant;
    let teardownCalls=0;
    manager.deliverySessions.set('reentrant-detach-session',{
      connection,
      close() {
        teardownCalls++;
        reentrant=host.close();
        return reentrant;
      },
    });
    const detaching=host.detachMcpClient('detach-with-session');
    const closing=host.close();
    let timer;
    await Promise.race([
      Promise.all([detaching,closing]),
      new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('detach/provider close cycle')),3000);
      }),
    ]).finally(()=>clearTimeout(timer));
    assert.equal(reentrant,closing);
    assert.equal(teardownCalls,1);
    assert.equal(manager.detachInFlight.size,0);
    assert.equal(manager.deliverySessions.size,0);
    assert.equal(manager.connections.has('detach-with-session'),false);
  } finally {
    await host?.close();
    await rm(dataDir,{recursive:true,force:true});
  }
});

test('shutdown rejects new gap reconciliation and drains a previously accepted durable repair', {
  timeout: 10000,
}, async()=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'ei-gap-ack-close-'));
  let host;
  let releaseRead;
  const held=new Promise(resolve=>{releaseRead=resolve});
  let signalEntered;
  const entered=new Promise(resolve=>{signalEntered=resolve});
  try {
    host=await createEventIntelligenceHost({dataDir,env});
    const manager=host.runtime.mcpEventsClient;
    manager.addConnection({
      connectionId:'repair-source',serverId:'upstream',
      getCapabilities:()=>({extensions:{'io.modelcontextprotocol/events':{}}}),
      request:async()=>({events:[]}),
    });
    const recorded=await host.store.putMcpClientState({
      connectionId:'repair-source',serverId:'upstream',
      eventName:'job.failed',arguments:{},deliveryMode:'poll',truncated:true,
    });
    const rawScopeContext=manager.scopeContext.bind(manager);
    manager.scopeContext=async connection=>{
      const context=await rawScopeContext(connection);
      return {
        ...context,
        store:{
          getMcpClientState:async(...args)=>{
            signalEntered();
            await held;
            return context.store.getMcpClientState(...args);
          },
          putMcpClientState:(...args)=>context.store.putMcpClientState(...args),
        },
      };
    };
    const params={
      connectionId:'repair-source',eventName:'job.failed',arguments:{},
      evidenceId:'host-proved-current-gap-replay',
      expectedCompletenessRevision:recorded.completenessRevision,
    };
    const accepted=manager.acknowledgeReconciledGap(params);
    await entered;
    let closed=false;
    const closing=host.close().then(()=>{closed=true});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(closed,false,
      'store teardown must wait for accepted host gap-reconciliation writes');
    await assert.rejects(manager.acknowledgeReconciledGap(params),
      error=>error?.code==='EI_HOST_CLOSED',
      'a late host gap receipt must not mutate already closing state');
    releaseRead();
    const repaired=await accepted;
    assert.equal(repaired.gapUnresolved,false);
    await closing;
    assert.equal(closed,true);
    assert.equal(manager.reconciliationInFlight.size,0);
    const reopened=new PersistentEventStore(dataDir);
    try {
      await reopened.init();
      const durable=reopened.getMcpClientState('repair-source','job.failed',{});
      assert.equal(durable.gapUnresolved,false);
      assert.equal(durable.reconciliationEvidenceId,'host-proved-current-gap-replay');
      assert.equal(durable.completenessRevision,recorded.completenessRevision+1);
    }finally{
      await reopened.close();
    }
  }finally{
    releaseRead?.();
    await host?.close();
    await rm(dataDir,{recursive:true,force:true});
  }
});


test('retained manager publishes close promise before reentrant provider teardown', {
  timeout: 10000,
}, async () => {
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'ei-manager-direct-reentrant-'));
  let host;
  try {
    host=await createEventIntelligenceHost({dataDir,env});
    const manager=host.runtime.mcpEventsClient;
    let nested;
    let calls=0;
    manager.deliverySessions.set('manager-direct-close',{
      close(){
        calls++;
        nested=host.close();
        return nested;
      },
    });
    const direct=manager.close();
    assert.equal(manager.close(),direct,
      'manager publishes one close promise before provider hooks');
    let timer;
    await Promise.race([
      Promise.all([direct,host.close()]),
      new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('manager reentrant teardown cycle')),3000);
      }),
    ]).finally(()=>clearTimeout(timer));
    await nested;
    assert.equal(calls,1);
    assert.equal(manager.close(),direct);
  }finally{
    await host?.close();
    await rm(dataDir,{recursive:true,force:true});
  }
});

test('completed ordinary detach unregisters shutdown notifications during connection churn', {
  timeout: 12000,
}, async () => {
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'ei-detach-listener-churn-'));
  let host;
  try {
    host=await createEventIntelligenceHost({dataDir,env});
    const manager=host.runtime.mcpEventsClient;
    for(let i=0;i<40;i++){
      const connectionId='churn-'+i;
      manager.addConnection({connectionId,serverId:'upstream',
        getCapabilities:()=>({extensions:{'io.modelcontextprotocol/events':{}}}),
        request:async()=>({events:[]})});
      await manager.detachConnection(connectionId);
      assert.equal(manager.shutdownListeners.size,0,
        'completed detaches must release shutdown closure even before close');
      assert.equal(manager.detachInFlight.size,0);
    }
    assert.equal(manager.closed,false);
  }finally{
    await host?.close();
    await rm(dataDir,{recursive:true,force:true});
  }
});
