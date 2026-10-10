import assert from 'node:assert/strict';
import test from 'node:test';
import { McpEventsClientManager } from '../scripts/lib/mcp-events-client.mjs';

function fixture({
  connectionId = 'same-id',
  delivery = 'poll',
  request,
  openEventStream,
} = {}) {
  const changes = { occurrences: 0, ingested: 0, cursors: 0 };
  const descriptor = {
    name: 'item.changed',
    delivery: [delivery],
    inputSchema: { type: 'object' },
    payloadSchema: { type: 'object' },
  };
  const store = {
    async listTriggers() {
      return [{
        triggerId: 'a-trigger', version: '1',
        clauses: [{
          id: 'event', serverId: 'mcp-server',
          event: 'item.changed', arguments: {},
        }],
      }];
    },
    async getTriggerState() { return { status: 'active' }; },
    async getMcpClientState() { return null; },
    async putMcpClientState(input) {
      changes.cursors++;
      return input;
    },
    async appendMcpOccurrence() {
      changes.occurrences++;
      return { accepted: true };
    },
    async listEventSources() { return []; },
  };
  const manager = new McpEventsClientManager({
    store,
    compositeEventConsumer: {
      async ingestMcpOccurrence() { changes.ingested++; },
    },
    registerEventSource: async () => {},
  });
  const add = (overrides = {}) => {
    const connection = manager.addConnection({
      connectionId,
      serverId: 'mcp-server',
      request: request ?? (async () => ({
        events: [], cursor: 'cursor', hasMore: false,
      })),
      getCapabilities: async () => ({}),
      ...(delivery === 'push' ? { openEventStream } : {}),
      ...overrides,
    });
    manager.descriptors.set(connectionId,[descriptor]);
    manager.profiles.set(connectionId,{pollMethod:'events/poll'});
    return connection;
  };
  return { manager, changes, descriptor, add, store };
}

const occurrence = Object.freeze({
  eventId: 'event-1',
  name: 'item.changed',
  timestamp: '2026-10-10T09:00:00.000Z',
  data: {},
});

test('detaching during an in-flight poll discards late results and cursor writes', async () => {
  let finishPoll;
  let pollStarted;
  const entered = new Promise(resolve => { pollStarted=resolve; });
  const gate = new Promise(resolve => { finishPoll=resolve; });
  const {manager, changes, add}=fixture({
    request: async () => {
      pollStarted();
      await gate;
      return { events:[occurrence],cursor:'late-cursor',hasMore:false };
    },
  });
  add();
  const pending = manager.pollConnection('same-id');
  await entered;
  await manager.detachConnection('same-id');
  finishPoll();
  await assert.rejects(
    pending,
    error => error.code==='MCP_EVENTS_CONNECTION_DETACHED',
  );
  assert.equal(changes.occurrences,0);
  assert.equal(changes.ingested,0);
  assert.equal(changes.cursors,0);
});

test('revoked poll callbacks cannot ingest after the same connection ID is reattached', async () => {
  let completeOld;
  let oldStarted;
  const entered=new Promise(resolve => { oldStarted=resolve; });
  const gate=new Promise(resolve => { completeOld=resolve; });
  const {manager,changes,add}=fixture({
    request: async () => {
      oldStarted();
      await gate;
      return {events:[occurrence],cursor:'revoked',hasMore:false};
    },
  });
  const oldConnection=add();
  const oldPoll=manager.pollConnection('same-id');
  await entered;
  await manager.detachConnection('same-id');
  const newer=add({
    request: async () => ({
      events:[occurrence],cursor:'new',hasMore:false,
    }),
  });
  assert.notEqual(newer,oldConnection);
  completeOld();
  await assert.rejects(oldPoll,
    error => error.code==='MCP_EVENTS_CONNECTION_DETACHED');
  const fresh=await manager.pollConnection('same-id');
  assert.equal(fresh[0].accepted,1);
  assert.equal(changes.occurrences,1);
  assert.equal(changes.ingested,1);
  assert.equal(changes.cursors,1);
});

test('late push callbacks after detach and same-ID reattachment are inert', async () => {
  let callbacks;
  let closeCount=0;
  const {manager,changes,descriptor,add}=fixture({
    delivery:'push',
    openEventStream: async (args) => {
      callbacks=args;
      return { close() { closeCount++; } };
    },
  });
  const previous=add();
  const context=await manager.scopeContext(previous);
  const subscription={
    subscriptionId:'sub-one', eventName:'item.changed',
    arguments:{}, descriptor, consumerRefs:['a-trigger@1:event'],
  };
  const opened=await manager.ensureDeliverySession(
    previous,context,subscription,'push',
  );
  assert.equal(opened.status,'active');
  await manager.detachConnection('same-id');
  assert.equal(closeCount,1);
  add();
  await callbacks.onEvent({...occurrence,cursor:'late'});
  await callbacks.onActive({cursor:'late'});
  await callbacks.onGap({cursor:'late'});
  callbacks.onError(new Error('old callback'));
  await callbacks.onTerminated('stale');
  assert.equal(changes.occurrences,0);
  assert.equal(changes.ingested,0);
  assert.equal(changes.cursors,1, 'only initial connection cursor setup');
  assert.equal(manager.lastErrors.has('same-id'),false);
});

test('push subscription opening after revocation closes orphan without re-registering',async()=>{
  let resolveOpen, openingStarted;
  const opened=new Promise(resolve=>{openingStarted=resolve;});
  const delayed=new Promise(resolve=>{resolveOpen=resolve;});
  let closed=0;
  const {manager,descriptor,add,changes}=fixture({
    delivery:'push',
    openEventStream:async()=>{openingStarted();return delayed;},
  });
  const old=add();
  const context=await manager.scopeContext(old);
  const subscription={
    subscriptionId:'late-open',eventName:'item.changed',
    arguments:{}, descriptor,consumerRefs:[],
  };
  const pending=manager.ensureDeliverySession(old,context,subscription,'push');
  await opened;
  await manager.detachConnection('same-id');
  resolveOpen({close(){closed++;}});
  const result=await pending;
  assert.equal(result.status,'detached');
  assert.equal(closed,1);
  assert.equal(manager.deliverySessions.size,0);
  assert.equal(changes.cursors,0);
});


function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('an old in-flight cursor write cannot overwrite the reattached session cursor', async () => {
  const entered = deferred();
  const release = deferred();
  const { manager, store, add } = fixture();
  let persisted = null;
  store.putMcpClientState = async (value) => {
    if (value.cursor === 'old-cursor') {
      entered.resolve();
      await release.promise;
    }
    persisted = value;
    return value;
  };
  store.getMcpClientState = async () => persisted;
  const old = add();
  const context = await manager.scopeContext(old);
  const subscription = {
    subscriptionId: 'state', eventName: 'item.changed', arguments: {},
  };
  const oldMutation = manager.saveSubscriptionState(
    old, context, subscription, { cursor: 'old-cursor' },
  );
  await entered.promise;
  const detach = manager.detachConnection('same-id');
  const fresh = add();
  const freshMutation = manager.saveSubscriptionState(
    fresh, context, subscription, { cursor: 'new-cursor' },
  );
  release.resolve();
  await Promise.all([oldMutation, detach, freshMutation]);
  assert.equal(persisted.cursor, 'new-cursor');
  assert.equal(persisted.serverId, 'mcp-server');
});

test('revoked discovery cannot re-enable a source after cleanup and replacement', async () => {
  const entered = deferred();
  const release = deferred();
  const { manager, store, add } = fixture();
  const sources = new Map();
  store.listEventSources = async () => [...sources.values()];
  manager.registerEventSource = async (source) => {
    if (source.enabled && source.serverId === 'old-server') {
      entered.resolve();
      await release.promise;
    }
    sources.set(source.sourceId, source);
  };
  const request = async () => ({
    events: [{
      name: 'item.changed',
      delivery: ['poll'],
      inputSchema: { type: 'object' },
      payloadSchema: { type: 'object' },
    }],
  });
  const getCapabilities = async () => ({
    extensions: { 'io.modelcontextprotocol/events': { listChanged: false } },
  });
  add({ serverId: 'old-server', request, getCapabilities });
  const oldDiscovery = manager.discoverConnection('same-id');
  await entered.promise;
  const detach = manager.detachConnection('same-id');
  add({ serverId: 'new-server', request, getCapabilities });
  const newDiscovery = manager.discoverConnection('same-id');
  release.resolve();
  await assert.rejects(oldDiscovery, e =>
    e.code === 'MCP_EVENTS_CONNECTION_DETACHED');
  await Promise.all([detach, newDiscovery]);
  const source = sources.get('mcp:same-id:item.changed');
  assert.equal(source.enabled, true);
  assert.equal(source.serverId, 'new-server');
});

test('old detach cleanup cannot close a replacement stream', async () => {
  const closeEntered = deferred();
  const releaseClose = deferred();
  let first = true;
  let replacementCloseCount = 0;
  const { manager, descriptor, add } = fixture({
    delivery: 'push',
    openEventStream: async () => {
      if (first) {
        first = false;
        return {
          async close() {
            closeEntered.resolve();
            await releaseClose.promise;
          },
        };
      }
      return { close() { replacementCloseCount++; } };
    },
  });
  const old = add();
  const context = await manager.scopeContext(old);
  const subscription = {
    subscriptionId: 'shared-subscription',
    eventName: 'item.changed',
    arguments: {}, descriptor, consumerRefs: [],
  };
  assert.equal((await manager.ensureDeliverySession(
    old, context, subscription, 'push',
  )).status, 'active');
  const detach = manager.detachConnection('same-id');
  await closeEntered.promise;
  const replacement = add();
  assert.equal((await manager.ensureDeliverySession(
    replacement, context, subscription, 'push',
  )).status, 'active');
  releaseClose.resolve();
  await detach;
  assert.equal(manager.deliverySessions.get(
    subscription.subscriptionId,
  ).connection, replacement);
  assert.equal(replacementCloseCount, 0);
});

test('revoking during stream cursor initialization closes orphan stream', async () => {
  const entered = deferred();
  const release = deferred();
  const { manager, store, descriptor, add } = fixture({
    delivery: 'push',
    openEventStream: async () => ({
      close() { closed++; },
    }),
  });
  let closed = 0;
  store.putMcpClientState = async (row) => {
    entered.resolve();
    await release.promise;
    return row;
  };
  const connection = add();
  const context = await manager.scopeContext(connection);
  const subscription = {
    subscriptionId: 'init-inflight',
    eventName: 'item.changed',
    arguments: {}, descriptor, consumerRefs: [],
  };
  const opening = manager.ensureDeliverySession(
    connection, context, subscription, 'push',
  );
  await entered.promise;
  const detach = manager.detachConnection('same-id');
  release.resolve();
  const result = await opening;
  await detach;
  assert.equal(result.status, 'detached');
  assert.equal(closed, 1);
  assert.equal(manager.deliverySessions.size, 0);
});


test('stale session reconciliation cannot remove a same-ID replacement',async()=>{
  const {manager,descriptor,add}=fixture({
    delivery:'push',
    openEventStream:async()=>({close(){}}),
  });
  const old=add();
  const context=await manager.scopeContext(old);
  const subscription={
    subscriptionId:'reused-sub', eventName:'item.changed',
    arguments:{},descriptor,consumerRefs:[],
  };
  await manager.ensureDeliverySession(old,context,subscription,'push');
  await manager.detachConnection('same-id');
  const replacement=add();
  await manager.ensureDeliverySession(replacement,context,subscription,'push');
  await assert.rejects(
    ()=>manager.reconcileDeliverySessions(old,new Set()),
    error=>error.code==='MCP_EVENTS_CONNECTION_DETACHED',
  );
  assert.equal(manager.deliverySessions.get('reused-sub').connection,replacement);
});
