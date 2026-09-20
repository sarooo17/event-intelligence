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
        experimental: {
          'io.modelcontextprotocol.experimental/events': {
            methods: ['events/list', 'events/poll'],
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
