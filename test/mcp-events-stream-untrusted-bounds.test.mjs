import assert from 'node:assert/strict';
import test from 'node:test';
import { McpEventsClientManager } from '../scripts/lib/mcp-events-client.mjs';

const event = () => ({
  eventId: 'evt-stream-1',
  name: 'order.changed',
  timestamp: '2026-10-11T12:00:00.000Z',
  data: { account: 'correct-owner' },
  cursor: 'cursor-correct',
});

function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(delivery) {
  const seen = { appended: [], ingested: [], saved: [] };
  let callbacks;
  let state = null;
  const store = {
    async getMcpClientState() { return state; },
    async putMcpClientState(update) {
      state = update;
      seen.saved.push({ ...update });
      return update;
    },
    async appendMcpOccurrence(_serverId, occurrence) {
      seen.appended.push(occurrence);
      return { accepted: true };
    },
    async listEventSources() { return []; },
  };
  const manager = new McpEventsClientManager({
    store,
    compositeEventConsumer: {
      async ingestMcpOccurrence({ event: occurrence }) {
        seen.ingested.push(occurrence);
      },
    },
    registerEventSource: async () => {},
  });
  const connection = manager.addConnection({
    connectionId: 'stream-boundary',
    serverId: 'producer',
    request: async () => ({}),
    getCapabilities: async () => ({}),
    ...(delivery === 'push'
      ? { openEventStream: async args => {
        callbacks = args;
        return { close() {} };
      } }
      : { createWebhookSubscription: async args => {
        callbacks = args;
        return { close() {} };
      } }),
  });
  const descriptor = {
    name: 'order.changed',
    delivery: [delivery],
    inputSchema: { type: 'object' },
    payloadSchema: { type: 'object' },
  };
  const subscription = {
    subscriptionId: 'bounded-stream-sub',
    eventName: descriptor.name,
    arguments: {}, descriptor, consumerRefs: ['trigger@1:e'],
  };
  const context = await manager.scopeContext(connection);
  const active = await manager.ensureDeliverySession(
    connection, context, subscription, delivery,
  );
  assert.equal(active.status, 'active');
  return { callbacks, manager, store, seen, getCursor: () => state?.cursor };
}

for (const delivery of ['push', 'webhook']) {
  test(`${delivery}: ordinary event, active cursor and gap callbacks still work`, async () => {
    const f = await fixture(delivery);
    await f.callbacks.onActive({ cursor: 'active-cursor', truncated: false });
    assert.equal(f.getCursor(), 'active-cursor');
    await f.callbacks.onEvent(event());
    assert.equal(f.getCursor(), 'cursor-correct');
    assert.equal(f.seen.appended.length, 1);
    assert.equal(f.seen.ingested.length, 1);
    assert.equal(f.seen.ingested[0].data.account, 'correct-owner');
    await f.callbacks.onGap({ cursor: 'gap-cursor' });
    assert.equal(f.getCursor(), 'gap-cursor');
    assert.equal(f.seen.saved.at(-1).truncated, true);
    await f.manager.detachConnection('stream-boundary');
  });

  test(`${delivery}: reject outer proxy and getter-backed event/cursor without invocation`, async () => {
    const f = await fixture(delivery);
    let traps = 0;
    const proxy = new Proxy(event(), {
      get() { traps++; return 'forged'; },
      ownKeys() { traps++; return ['eventId']; },
    });
    const accessorCursor = event();
    Object.defineProperty(accessorCursor, 'cursor', {
      enumerable: true,
      get() { traps++; return 'stolen-cursor'; },
    });
    const nestedData = event();
    Object.defineProperty(nestedData.data, 'private', {
      enumerable: true,
      get() { traps++; return 'leak'; },
    });
    const savedBefore = f.seen.saved.length;
    for (const hostile of [proxy, accessorCursor, nestedData]) {
      await assert.rejects(f.callbacks.onEvent(hostile),
        error => error.code === 'EVENT_UNTRUSTED_DATA_INVALID');
    }
    assert.equal(traps, 0);
    assert.equal(f.seen.appended.length, 0);
    assert.equal(f.seen.ingested.length, 0);
    assert.equal(f.seen.saved.length, savedBefore);
    await f.manager.detachConnection('stream-boundary');
  });

  test(`${delivery}: reject malformed event cursor before durable append`, async () => {
    const f = await fixture(delivery);
    const before = f.seen.saved.length;
    await assert.rejects(
      f.callbacks.onEvent({ ...event(), cursor: { forged: 'not-opaque' } }),
      error => error.message.includes('expected string|null'),
    );
    assert.equal(f.seen.appended.length, 0);
    assert.equal(f.seen.ingested.length, 0);
    assert.equal(f.seen.saved.length, before);
    await f.manager.detachConnection('stream-boundary');
  });

  test(`${delivery}: reject accessor and proxy cursor-state updates before persistence`, async () => {
    const f = await fixture(delivery);
    let traps = 0;
    const accessorUpdate = {};
    Object.defineProperty(accessorUpdate, 'cursor', {
      enumerable: true,
      get() { traps++; return 'forged'; },
    });
    const proxyUpdate = new Proxy({ cursor: 'forged' }, {
      ownKeys() { traps++; return ['cursor']; },
    });
    const before = f.seen.saved.length;
    for (const bad of [accessorUpdate, proxyUpdate]) {
      await assert.rejects(f.callbacks.onActive(bad),
        error => error.code === 'EVENT_UNTRUSTED_DATA_INVALID');
      await assert.rejects(f.callbacks.onGap(bad),
        error => error.code === 'EVENT_UNTRUSTED_DATA_INVALID');
    }
    assert.equal(traps, 0);
    assert.equal(f.seen.saved.length, before);
    await f.manager.detachConnection('stream-boundary');
  });

  test(`${delivery}: snapshot event and cursor before asynchronous storage can see producer mutation`, async () => {
    const f = await fixture(delivery);
    const entered = deferred();
    const release = deferred();
    f.store.appendMcpOccurrence = async (_serverId, occurrence) => {
      f.seen.appended.push(occurrence);
      entered.release();
      await release.promise;
      return { accepted: true };
    };
    const mutable = event();
    const pending = f.callbacks.onEvent(mutable);
    await entered.promise;
    mutable.eventId = 'evt-forged';
    mutable.data.account = 'other-owner';
    mutable.cursor = 'cursor-forged';
    release.release();
    await pending;
    assert.equal(f.seen.appended[0].eventId, 'evt-stream-1');
    assert.equal(f.seen.appended[0].data.account, 'correct-owner');
    assert.equal(f.seen.ingested[0].eventId, 'evt-stream-1');
    assert.equal(f.getCursor(), 'cursor-correct');
    await f.manager.detachConnection('stream-boundary');
  });
}
