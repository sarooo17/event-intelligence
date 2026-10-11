import assert from 'node:assert/strict';
import test from 'node:test';
import { McpEventsClientManager } from '../scripts/lib/mcp-events-client.mjs';

const descriptor = {
  name: 'order.created',
  delivery: ['poll'],
  inputSchema: { type: 'object' },
  payloadSchema: { type: 'object' },
};

function occurrence(id) {
  return {
    eventId: 'order-' + id,
    name: descriptor.name,
    timestamp: '2026-10-11T12:00:00.000Z',
    data: { confidential: 'must-not-leak' },
  };
}

function fixture({ maxEvents = 1, maxPollBatches = 2, responses }) {
  const receipts = {
    appended: [], ingested: [], persisted: [], rpcInputs: [],
  };
  let cursorState = null;
  const store = {
    async getMcpClientState() { return cursorState; },
    async putMcpClientState(next) {
      cursorState = next;
      receipts.persisted.push(next.cursor);
      return next;
    },
    async appendMcpOccurrence(serverId, event, subscriptionId) {
      receipts.appended.push({ serverId, id: event.eventId, subscriptionId });
      return { accepted: true };
    },
  };
  const manager = new McpEventsClientManager({
    store,
    compositeEventConsumer: {
      async ingestMcpOccurrence({ event }) {
        receipts.ingested.push(event.eventId);
      },
    },
    registerEventSource: async () => {},
  });
  const connection = manager.addConnection({
    connectionId: 'tenant-poll',
    serverId: 'tenant-server',
    maxEvents,
    maxPollBatches,
    request: async (_method, params) => {
      receipts.rpcInputs.push({ cursor: params.cursor, maxEvents: params.maxEvents });
      if (!responses.length) throw new Error('No more responses');
      return responses.shift();
    },
    getCapabilities: async () => ({}),
  });
  manager.profiles.set(connection.connectionId, { pollMethod: 'events/poll' });
  const subscription = {
    subscriptionId: 'subscription',
    eventName: descriptor.name,
    arguments: {},
    descriptor,
    consumerRefs: ['tenant-trigger@1:e'],
  };
  return {
    manager, connection, subscription, receipts, store,
    poll: () => manager.pollSubscription(connection,
      { store, compositeEventConsumer: manager.compositeEventConsumer },
      subscription),
    getCursor: () => cursorState?.cursor ?? null,
  };
}

test('oversized producer poll page is rejected before any append, wake processing or cursor mutation', async () => {
  const f = fixture({
    maxEvents: 1,
    responses: [
      { events: [occurrence('a'), occurrence('b')], cursor: 'bad-next', hasMore: false },
      { events: [occurrence('a')], cursor: 'good-next', hasMore: false },
    ],
  });
  await assert.rejects(f.poll(), (error) => {
    assert.equal(error.code, 'MCP_EVENTS_POLL_BATCH_LIMIT_EXCEEDED');
    assert.doesNotMatch(error.message, /must-not-leak|order-a|tenant-server|bad-next/);
    return true;
  });
  assert.deepEqual(f.receipts.appended, []);
  assert.deepEqual(f.receipts.ingested, []);
  assert.deepEqual(f.receipts.persisted, []);
  assert.equal(f.getCursor(), null, 'oversized cursor must never advance');

  const good = await f.poll();
  assert.equal(good.accepted, 1);
  assert.equal(f.getCursor(), 'good-next');
  assert.deepEqual(f.receipts.appended.map(x => x.id), ['order-a']);
  assert.deepEqual(f.receipts.ingested, ['order-a']);
  assert.deepEqual(f.receipts.rpcInputs.map(x => x.cursor), [null, null],
    'retry starts at unchanged cursor and can accept a legitimate replay');
  assert.ok(f.receipts.rpcInputs.every(x => x.maxEvents === 1));
});

test('exact limit is accepted, and multi-page polling remains bounded per page', async () => {
  const f = fixture({
    maxEvents: 2,
    responses: [
      { events: [occurrence('a'), occurrence('b')], cursor: 'page-1', hasMore: true },
      { events: [occurrence('c'), occurrence('d')], cursor: 'page-2', hasMore: false },
    ],
  });
  const out = await f.poll();
  assert.equal(out.accepted, 4, 'per-page max is not a false total-run cap');
  assert.equal(out.batches, 2);
  assert.equal(f.getCursor(), 'page-2');
  assert.deepEqual(f.receipts.persisted, ['page-1', 'page-2']);
  assert.deepEqual(f.receipts.rpcInputs.map(x => x.cursor), [null, 'page-1']);
  assert.equal(f.receipts.ingested.length, 4);
});

test('global producer limit of 500 events is enforced even when the page advertises hasMore', async () => {
  const f = fixture({
    maxEvents: 500,
    responses: [{
      events: Array.from({ length: 501 }, (_, index) => occurrence(index)),
      cursor: 'never-stored',
      hasMore: true,
    }],
  });
  await assert.rejects(f.poll(), (error) =>
    error.code === 'MCP_EVENTS_POLL_BATCH_LIMIT_EXCEEDED');
  assert.equal(f.receipts.appended.length, 0);
  assert.equal(f.receipts.persisted.length, 0);
  assert.equal(f.getCursor(), null);
});

test('a mutated provider array or custom iterator cannot inject after the cap check', async () => {
  let firstStarted;
  let continueFirst;
  const started = new Promise(resolve => { firstStarted = resolve; });
  const release = new Promise(resolve => { continueFirst = resolve; });
  const page = [occurrence('a'), occurrence('b')];
  const f = fixture({
    maxEvents: 2,
    responses: [{ events: page, cursor: 'safe-next', hasMore: false }],
  });
  // The host adapter's iterator advertises a third event even though the
  // JSON array has only two own indices.
  page[Symbol.iterator] = function* () {
    yield page[0];
    yield page[1];
    yield occurrence('iterator-excess');
  };
  let initial = true;
  f.manager.compositeEventConsumer.ingestMcpOccurrence = async ({ event }) => {
    if (initial) {
      initial = false;
      firstStarted();
      await release;
    }
    f.receipts.ingested.push(event.eventId);
  };
  const running = f.poll();
  await started;
  page.push(occurrence('appended-while-ingesting'));
  page[1].eventId = 'producer-mutated-second-event';
  continueFirst();
  const result = await running;
  assert.equal(result.accepted, 2);
  assert.deepEqual(f.receipts.appended.map(x => x.id), ['order-a', 'order-b']);
  assert.deepEqual(f.receipts.ingested, ['order-a', 'order-b']);
  assert.equal(f.getCursor(), 'safe-next');
});

test('poll page snapshots reject accessor entries without executing getters or writing state', async () => {
  let accessorInvocations = 0;
  const page = [occurrence('a')];
  Object.defineProperty(page, '0', {
    enumerable: true,
    configurable: true,
    get() {
      accessorInvocations++;
      return occurrence('malicious');
    },
  });
  const f = fixture({
    maxEvents: 2,
    responses: [{ events: page, cursor: 'bad-accessor', hasMore: false }],
  });
  await assert.rejects(f.poll(),
    error => error.code === 'MCP_EVENTS_POLL_BATCH_INVALID');
  assert.equal(accessorInvocations, 0);
  assert.deepEqual(f.receipts.appended, []);
  assert.deepEqual(f.receipts.persisted, []);
});

test('poll page snapshots reject nested getters and JS Proxies before append', async () => {
  let called = 0;
  const nested = { order: 'legitimate' };
  Object.defineProperty(nested, 'secret', {
    enumerable: true,
    get() {
      called++;
      return 'private';
    },
  });
  for (const data of [nested, new Proxy({ order: 'legitimate' }, {
    ownKeys() {
      called++;
      return ['order'];
    },
  })]) {
    const event = { ...occurrence('unsafe'), data };
    const f = fixture({
      maxEvents: 1,
      responses: [{ events: [event], cursor: 'never', hasMore: false }],
    });
    await assert.rejects(f.poll(),
      error => error.code === 'EVENT_UNTRUSTED_DATA_INVALID');
    assert.equal(f.receipts.appended.length, 0);
    assert.equal(f.receipts.persisted.length, 0);
  }
  assert.equal(called, 0, 'unsafe accessor or proxy code must not execute');
});
