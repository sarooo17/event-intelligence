import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import {
  McpEventsClientManager,
  createHostMcpEventsConnection,
} from '../scripts/lib/mcp-events-client.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TriggerControlPlane } from '../scripts/lib/trigger-control-plane.mjs';

test('concurrent polls for one MCP connection share a single in-flight request', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-poll-singleflight-'));
  let releasePoll;
  const gate = new Promise((resolve) => {
    releasePoll = resolve;
  });
  let pollCalls = 0;

  const client = {
    getServerCapabilities() {
      return {
        extensions: {
          'io.modelcontextprotocol/events': {
            listChanged: false,
          },
        },
      };
    },
    async request(message) {
      if (message.method === 'events/list') {
        return {
          events: [{
            name: 'slow.event',
            delivery: ['poll'],
            payloadSchema: { type: 'object' },
          }],
        };
      }
      if (message.method === 'events/poll') {
        pollCalls += 1;
        await gate;
        return {
          events: [],
          cursor: 'cursor-1',
          hasMore: false,
        };
      }
      throw new Error(`Unexpected method ${message.method}`);
    },
  };

  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const triggerEngine = new CompositeTriggerEngine(store);
    const consumer = new CompositeEventConsumer({
      store,
      triggerEngine,
      wakeCoordinators: new Map(),
    });
    const control = new TriggerControlPlane({
      store,
      triggerEngine,
    });
    const manager = new McpEventsClientManager({
      store,
      compositeEventConsumer: consumer,
      connections: [createHostMcpEventsConnection({
        connectionId: 'slow',
        serverId: 'slow-mcp',
        client,
        pollIntervalMs: 300000,
      })],
      registerEventSource: (source) =>
        control.registerEventSource(source, {
          type: 'system',
          principal_id: 'event-intelligence:test',
        }),
    });

    await manager.discoverAll();
    await control.createTrigger({
      definition: {
        triggerId: 'slow-trigger',
        version: '1',
        clauses: [{
          id: 'slow',
          event: 'slow.event',
          serverId: 'slow-mcp',
          arguments: {},
          where: [],
        }],
        expression: { kind: 'anyOf', refs: ['slow'] },
        withinMs: 60000,
        target: { runtime: 'test', kind: 'task', id: 'slow' },
      },
      connectionIds: ['slow'],
      actor: { type: 'user', principal_id: 'test-user' },
      owner: { type: 'user', principal_id: 'test-user' },
    });

    const first = manager.pollConnection('slow');
    await new Promise((resolve) => setImmediate(resolve));
    const second = manager.pollConnection('slow');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(pollCalls, 1);
    releasePoll();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(secondResult, firstResult);
    assert.equal(pollCalls, 1);
    assert.equal(
      store.getMcpClientState('slow', 'slow.event').cursor,
      'cursor-1',
    );
  } finally {
    releasePoll?.();
    await rm(dir, { recursive: true, force: true });
  }
});


test('poll draining is bounded while persisting the cursor after every batch', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-poll-batches-'));
  let pollCalls = 0;

  const client = {
    getServerCapabilities() {
      return {
        extensions: {
          'io.modelcontextprotocol/events': {
            listChanged: false,
          },
        },
      };
    },
    async request(message) {
      if (message.method === 'events/list') {
        return {
          events: [{
            name: 'paged.event',
            delivery: ['poll'],
            payloadSchema: {
              type: 'object',
              required: ['page'],
              properties: { page: { type: 'number' } },
            },
          }],
        };
      }
      if (message.method !== 'events/poll') {
        throw new Error(`Unexpected method ${message.method}`);
      }

      pollCalls += 1;
      const cursor = message.params?.cursor;
      if (!cursor) {
        return {
          events: [{
            eventId: 'page-1',
            name: 'paged.event',
            timestamp: '2026-09-20T14:00:00.000Z',
            data: { page: 1 },
          }],
          cursor: 'c1',
          hasMore: true,
        };
      }
      if (cursor === 'c1') {
        return {
          events: [{
            eventId: 'page-2',
            name: 'paged.event',
            timestamp: '2026-09-20T14:00:01.000Z',
            data: { page: 2 },
          }],
          cursor: 'c2',
          hasMore: true,
        };
      }
      return {
        events: [{
          eventId: 'page-3',
          name: 'paged.event',
          timestamp: '2026-09-20T14:00:02.000Z',
          data: { page: 3 },
        }],
        cursor: 'c3',
        hasMore: false,
      };
    },
  };

  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const triggerEngine = new CompositeTriggerEngine(store);
    const consumer = new CompositeEventConsumer({
      store,
      triggerEngine,
      wakeCoordinators: new Map(),
    });
    const control = new TriggerControlPlane({
      store,
      triggerEngine,
    });
    const manager = new McpEventsClientManager({
      store,
      compositeEventConsumer: consumer,
      connections: [createHostMcpEventsConnection({
        connectionId: 'paged',
        serverId: 'paged-mcp',
        client,
        pollIntervalMs: 300000,
        maxPollBatches: 2,
      })],
      registerEventSource: (source) =>
        control.registerEventSource(source, {
          type: 'system',
          principal_id: 'event-intelligence:test',
        }),
    });

    await manager.discoverAll();
    await control.createTrigger({
      definition: {
        triggerId: 'paged-trigger',
        version: '1',
        clauses: [{
          id: 'paged',
          event: 'paged.event',
          serverId: 'paged-mcp',
          arguments: {},
          where: [],
        }],
        expression: { kind: 'anyOf', refs: ['paged'] },
        withinMs: 60000,
        target: { runtime: 'test', kind: 'task', id: 'paged' },
      },
      connectionIds: ['paged'],
      actor: { type: 'user', principal_id: 'test-user' },
      owner: { type: 'user', principal_id: 'test-user' },
    });
    const first = await manager.pollConnection('paged');
    assert.equal(first[0].batches, 2);
    assert.equal(first[0].accepted, 2);
    assert.equal(first[0].batchLimitReached, true);
    assert.equal(
      store.getMcpClientState('paged', 'paged.event').cursor,
      'c2',
    );

    const second = await manager.pollConnection('paged');
    assert.equal(second[0].batches, 1);
    assert.equal(second[0].accepted, 1);
    assert.equal(second[0].batchLimitReached, false);
    assert.equal(
      store.getMcpClientState('paged', 'paged.event').cursor,
      'c3',
    );
    assert.equal(pollCalls, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
