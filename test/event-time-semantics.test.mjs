import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { mcpOccurrenceToCorrelatableEvent } from '../dist/src/mcpEvents/consumer.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import {
  McpEventsClientManager,
  createHostMcpEventsConnection,
} from '../scripts/lib/mcp-events-client.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TriggerControlPlane } from '../scripts/lib/trigger-control-plane.mjs';
import { TriggerPlanner } from '../scripts/lib/trigger-planner.mjs';

function sourceEvent(id, name, occurredAt, receivedAt) {
  return {
    traceId: `trace_${id}`,
    sourceEventId: id,
    name,
    occurredAt,
    ...(receivedAt ? { receivedAt } : {}),
    data: {},
  };
}

function sequenceCondition(triggerId, withinMs) {
  return {
    triggerId,
    version: '1',
    conditionOnly: true,
    clauses: [
      { id: 'a', event: 'event.a', where: [] },
      { id: 'b', event: 'event.b', where: [] },
    ],
    pattern: {
      root: {
        kind: 'sequence',
        contiguity: 'followedBy',
        children: [
          { kind: 'event', ref: 'a' },
          { kind: 'event', ref: 'b' },
        ],
      },
    },
    withinMs,
  };
}

test('out-of-order delivery uses event time and can satisfy a sequence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-event-time-order-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    await engine.register(sequenceCondition('out-of-order-sequence', 10 * 60 * 1000));

    const laterFirst = await engine.ingest(sourceEvent(
      'b-1',
      'event.b',
      '2026-09-30T10:05:00.000Z',
      '2026-09-30T10:05:01.000Z',
    ));
    assert.equal(laterFirst[0].matched, false);
    assert.equal(laterFirst[0].match.openedAt, '2026-09-30T10:05:00.000Z');

    const earlierSecond = await engine.ingest(sourceEvent(
      'a-1',
      'event.a',
      '2026-09-30T10:00:00.000Z',
      '2026-09-30T10:06:00.000Z',
    ));

    assert.equal(earlierSecond[0].matched, true);
    assert.equal(earlierSecond[0].match.openedAt, '2026-09-30T10:00:00.000Z');
    assert.equal(earlierSecond[0].match.expiresAt, '2026-09-30T10:10:00.000Z');
    assert.deepEqual(
      earlierSecond[0].match.sourceEvents
        .map((event) => [event.eventName, event.occurredAt, event.receivedAt])
        .sort(),
      [
        ['event.a', '2026-09-30T10:00:00.000Z', '2026-09-30T10:06:00.000Z'],
        ['event.b', '2026-09-30T10:05:00.000Z', '2026-09-30T10:05:01.000Z'],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repeated sequence clauses preserve alternate valid windows', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-event-time-alternates-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    await engine.register({
      ...sequenceCondition('alternate-sequence-window', 10 * 60 * 1000),
      eventTime: { allowedLatenessMs: 20 * 60 * 1000 },
    });

    await engine.ingest(sourceEvent(
      'a-late',
      'event.a',
      '2026-09-30T10:15:00.000Z',
      '2026-09-30T10:15:01.000Z',
    ));

    await engine.ingest(sourceEvent(
      'a-early',
      'event.a',
      '2026-09-30T10:08:00.000Z',
      '2026-09-30T10:16:00.000Z',
    ));

    const buffers = store.listTriggerMatches('alternate-sequence-window')
      .filter((match) => match.patternState?.role === 'buffer');
    assert.equal(buffers.length, 1);
    assert.deepEqual(
      buffers[0].sourceEvents.map((event) => event.sourceEventId).sort(),
      ['a-early', 'a-late'],
    );

    const result = await engine.ingest(sourceEvent(
      'b-valid',
      'event.b',
      '2026-09-30T10:20:00.000Z',
      '2026-09-30T10:20:01.000Z',
    ));

    assert.equal(result[0].matched, true);
    assert.equal(result[0].match.openedAt, '2026-09-30T10:15:00.000Z');
    assert.equal(result[0].match.expiresAt, '2026-09-30T10:25:00.000Z');
    assert.deepEqual(
      result[0].match.sourceEvents.map((event) => event.sourceEventId).sort(),
      ['a-late', 'b-valid'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('allowed lateness keeps a compatible older partial behind a newer event', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-event-time-lateness-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    await engine.register({
      ...sequenceCondition('lateness-aware-sequence', 10 * 60 * 1000),
      eventTime: { allowedLatenessMs: 10 * 60 * 1000 },
    });

    await engine.ingest(sourceEvent(
      'b-old',
      'event.b',
      '2026-09-30T10:05:00.000Z',
      '2026-09-30T10:05:01.000Z',
    ));

    await engine.ingest(sourceEvent(
      'b-new',
      'event.b',
      '2026-09-30T10:20:00.000Z',
      '2026-09-30T10:20:01.000Z',
    ));

    const lateA = await engine.ingest(sourceEvent(
      'a-late',
      'event.a',
      '2026-09-30T10:00:00.000Z',
      '2026-09-30T10:21:00.000Z',
    ));

    assert.equal(lateA[0].matched, true);
    assert.deepEqual(
      lateA[0].match.sourceEvents.map((event) => event.sourceEventId).sort(),
      ['a-late', 'b-old'],
    );
    assert.equal(lateA[0].match.openedAt, '2026-09-30T10:00:00.000Z');
    assert.equal(lateA[0].match.expiresAt, '2026-09-30T10:10:00.000Z');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('zero lateness drops stale events instead of creating a false sequence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-event-time-window-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    await engine.register(sequenceCondition('window-isolation', 5 * 60 * 1000));

    await engine.ingest(sourceEvent(
      'b-late',
      'event.b',
      '2026-09-30T10:10:00.000Z',
      '2026-09-30T10:10:01.000Z',
    ));

    const tooOld = await engine.ingest(sourceEvent(
      'a-old',
      'event.a',
      '2026-09-30T10:00:00.000Z',
      '2026-09-30T10:11:00.000Z',
    ));
    assert.equal(tooOld[0].matched, false);
    assert.equal(
      store.listTriggerMatches('window-isolation')
        .filter((match) => match.status === 'matched').length,
      0,
    );

    const compatibleB = await engine.ingest(sourceEvent(
      'b-compatible',
      'event.b',
      '2026-09-30T10:03:00.000Z',
      '2026-09-30T10:12:00.000Z',
    ));
    assert.equal(tooOld[0].match.status, 'partial');
    assert.deepEqual(
      tooOld[0].match.sourceEvents.map((event) => event.sourceEventId),
      ['b-late'],
    );
    assert.equal(compatibleB[0].matched, false);
    assert.equal(compatibleB[0].match.status, 'partial');
    assert.deepEqual(
      compatibleB[0].match.sourceEvents.map((event) => event.sourceEventId),
      ['b-late'],
    );
    assert.equal(
      store.listTriggerMatches('window-isolation')
        .filter((match) => match.status === 'matched').length,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MCP ingress preserves provider event time and host receive time separately', async () => {
  const event = await mcpOccurrenceToCorrelatableEvent(
    {
      eventId: 'evt-1',
      name: 'invoice.submitted',
      timestamp: '2026-09-30T12:00:00.000Z',
      data: { total: 1200 },
    },
    {
      traceId: 'trace-1',
      serverId: 'erp',
      provider: 'mcp',
      receivedAt: '2026-09-30T12:00:07.000Z',
    },
  );

  assert.equal(event.occurredAt, '2026-09-30T12:00:00.000Z');
  assert.equal(event.receivedAt, '2026-09-30T12:00:07.000Z');
});

test('planner can compile a persistent condition without an activation target', async () => {
  const planner = new TriggerPlanner({
    store: {
      listEventSources() {
        return [{
          sourceId: 'source-a',
          connectionId: 'conn-a',
          serverId: 'server-a',
          eventName: 'event.a',
          enabled: true,
          delivery: ['poll'],
          inputSchema: {},
          payloadSchema: { type: 'object' },
        }];
      },
    },
  });

  const planned = await planner.plan({
    triggerId: 'condition-only-plan',
    conditionOnly: true,
    events: [{ event: 'event.a' }],
  });

  assert.equal(planned.definition.conditionOnly, true);
  assert.equal(planned.definition.target, undefined);
  assert.equal(planned.definition.continuation, undefined);
  assert.equal(planned.explanation.then.conditionOnly, true);
});

test('multiple triggers share one upstream MCP subscription for identical arguments', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-shared-subscription-'));
  let pollCalls = 0;

  const client = {
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
            name: 'shared.event',
            delivery: ['poll'],
            inputSchema: { type: 'object' },
            payloadSchema: { type: 'object' },
          }],
        };
      }
      if (message.method === 'events/poll') {
        pollCalls += 1;
        return {
          events: [],
          cursor: 'shared-cursor',
          hasMore: false,
        };
      }
      throw new Error(`Unexpected method ${message.method}`);
    },
  };

  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    const consumer = new CompositeEventConsumer({
      store,
      triggerEngine: engine,
      wakeCoordinators: new Map(),
    });
    const control = new TriggerControlPlane({ store, triggerEngine: engine });
    const manager = new McpEventsClientManager({
      store,
      compositeEventConsumer: consumer,
      connections: [createHostMcpEventsConnection({
        connectionId: 'shared',
        serverId: 'shared-mcp',
        client,
        pollIntervalMs: 300000,
      })],
      registerEventSource: (source) => control.registerEventSource(source, {
        type: 'system',
        principal_id: 'event-intelligence:test',
      }),
    });

    await manager.discoverAll();

    for (const triggerId of ['shared-one', 'shared-two']) {
      await control.createTrigger({
        definition: {
          triggerId,
          version: '1',
          conditionOnly: true,
          clauses: [{
            id: 'shared',
            event: 'shared.event',
            serverId: 'shared-mcp',
            arguments: {},
            where: [],
          }],
          pattern: { root: { kind: 'event', ref: 'shared' } },
          withinMs: 60000,
        },
        connectionIds: ['shared'],
        actor: { type: 'user', principal_id: 'user-1' },
        owner: { type: 'user', principal_id: 'user-1' },
      });
    }

    const result = await manager.pollConnection('shared');
    assert.equal(result.length, 1);
    assert.equal(result[0].consumerCount, 2);
    assert.equal(pollCalls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
