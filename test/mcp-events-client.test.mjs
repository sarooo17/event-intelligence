import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import {
  McpEventsClientManager,
  assertJsonSchemaValue,
  createHostMcpEventsConnection,
} from '../scripts/lib/mcp-events-client.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TriggerControlPlane } from '../scripts/lib/trigger-control-plane.mjs';

function fakeConnectedMcpClient({ eventName, eventId, data }) {
  let cursor = null;
  const capabilities = {
    experimental: {
      'io.modelcontextprotocol.experimental/events': {
        status: 'draft',
        methods: ['events/list', 'events/poll'],
      },
    },
  };

  return {
    getServerCapabilities() {
      return capabilities;
    },
    async request(message) {
      if (message.method === 'events/list') {
        return {
          events: [{
            name: eventName,
            description: `Fake ${eventName}`,
            delivery: ['poll'],
            inputSchema: { type: 'object' },
            payloadSchema: {
              type: 'object',
              required: ['entityId'],
              properties: {
                entityId: { type: 'string' },
              },
            },
          }],
        };
      }

      if (message.method === 'events/poll') {
        const requested = message.params?.cursor;
        if (requested === null || requested === undefined) {
          cursor = 'c0';
          return {
            events: [],
            cursor,
            hasMore: false,
            nextPollMs: 1000,
          };
        }
        if (requested === 'c0') {
          cursor = 'c1';
          return {
            events: [{
              eventId,
              name: eventName,
              timestamp: '2026-09-18T20:00:00.000Z',
              data,
            }],
            cursor,
            hasMore: false,
            nextPollMs: 1000,
          };
        }
        return {
          events: [],
          cursor: cursor ?? 'c1',
          hasMore: false,
          nextPollMs: 1000,
        };
      }

      throw new Error(`Unexpected MCP request: ${message.method}`);
    },
  };
}

function connection(connectionId, serverId, client) {
  return createHostMcpEventsConnection({
    connectionId,
    serverId,
    client,
    pollIntervalMs: 1000,
    maxEvents: 50,
  });
}

async function buildRuntime(dir, connections) {
  const store = new PersistentEventStore(dir);
  await store.init();
  const engine = new CompositeTriggerEngine(store);
  const consumer = new CompositeEventConsumer({
    store,
    triggerEngine: engine,
    wakeCoordinators: new Map(),
  });
  const control = new TriggerControlPlane({
    store,
    triggerEngine: engine,
  });
  const manager = new McpEventsClientManager({
    store,
    compositeEventConsumer: consumer,
    connections,
    registerEventSource: (source) =>
      control.registerEventSource(source, {
        type: 'system',
        principal_id: 'event-intelligence:host-mcp-client',
      }),
  });
  return { store, engine, consumer, control, manager };
}

test('two host-owned MCP clients auto-discover, correlate and resume cursors after restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-host-client-'));

  try {
    const clients = [
      connection(
        'conn_alpha',
        'alpha-mcp',
        fakeConnectedMcpClient({
          eventName: 'alpha.opened',
          eventId: 'alpha_1',
          data: { entityId: 'entity-42' },
        }),
      ),
      connection(
        'conn_beta',
        'beta-mcp',
        fakeConnectedMcpClient({
          eventName: 'beta.confirmed',
          eventId: 'beta_1',
          data: { entityId: 'entity-42' },
        }),
      ),
    ];

    const first = await buildRuntime(dir, clients);

    const discovery = await first.manager.discoverAll();
    assert.deepEqual(discovery.map((item) => item.status), ['ready', 'ready']);

    const sources = first.control.listEventSources({
      connectionIds: ['conn_alpha', 'conn_beta'],
    });
    assert.deepEqual(
      sources.map((source) => source.eventName).sort(),
      ['alpha.opened', 'beta.confirmed'],
    );
    assert.ok(sources.every((source) => source.metadata?.hostManaged === true));

    await first.control.createTrigger({
      definition: {
        protocolVersion: '0.1.0',
        schemaVersion: 'trigger.v0.1',
        triggerId: 'generic-cross-server',
        version: '1',
        clauses: [
          { id: 'alpha', event: 'alpha.opened', serverId: 'alpha-mcp', where: [] },
          { id: 'beta', event: 'beta.confirmed', serverId: 'beta-mcp', where: [] },
        ],
        expression: { kind: 'allOf', refs: ['alpha', 'beta'] },
        withinMs: 3600000,
        correlation: {
          deterministic: {
            kind: 'same_value',
            fields: [
              { ref: 'alpha', path: 'entityId' },
              { ref: 'beta', path: 'entityId' },
            ],
          },
        },
        target: { runtime: 'test-runtime', kind: 'task', id: 'proof' },
      },
      connectionIds: ['conn_alpha', 'conn_beta'],
      actor: { type: 'user', principal_id: 'user_1' },
      owner: { type: 'user', principal_id: 'user_1' },
    });

    const establish = await first.manager.pollAll();
    assert.equal(establish[0].results[0].accepted, 0);
    assert.equal(establish[1].results[0].accepted, 0);

    const ingest = await first.manager.pollAll();
    assert.equal(ingest[0].results[0].accepted, 1);
    assert.equal(ingest[1].results[0].accepted, 1);

    const matches = first.store.listTriggerMatches('generic-cross-server');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].status, 'matched');

    assert.equal(first.store.getMcpClientState('conn_alpha', 'alpha.opened').cursor, 'c1');
    assert.equal(first.store.getMcpClientState('conn_beta', 'beta.confirmed').cursor, 'c1');

    const restartedClients = [
      connection(
        'conn_alpha',
        'alpha-mcp',
        fakeConnectedMcpClient({
          eventName: 'alpha.opened',
          eventId: 'alpha_1',
          data: { entityId: 'entity-42' },
        }),
      ),
      connection(
        'conn_beta',
        'beta-mcp',
        fakeConnectedMcpClient({
          eventName: 'beta.confirmed',
          eventId: 'beta_1',
          data: { entityId: 'entity-42' },
        }),
      ),
    ];
    const second = await buildRuntime(dir, restartedClients);
    assert.equal(second.store.listMcpClientStates().length, 2);
    await second.manager.discoverAll();

    // Persisted cursors are owned by EI even though the MCP transports are
    // recreated and still owned by the host.
    const afterRestart = await second.manager.pollAll();
    assert.equal(afterRestart[0].results[0].accepted, 0);
    assert.equal(afterRestart[1].results[0].accepted, 0);
    assert.equal(second.store.listTriggerMatches('generic-cross-server').length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('host MCP adapter requires an existing client/request and validates payload schema', () => {
  assert.throws(
    () => createHostMcpEventsConnection({ connectionId: 'missing-client' }),
    /requires request/,
  );

  assert.doesNotThrow(() => assertJsonSchemaValue({
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  }, { id: 'ok' }));

  assert.throws(() => assertJsonSchemaValue({
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  }, { id: 42 }));
});
