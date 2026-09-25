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
    extensions: {
      'io.modelcontextprotocol/events': {
        listChanged: false,
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


test('subscription arguments create independent durable cursor state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-subscription-args-'));
  const calls = [];
  const cursors = new Map();

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
            name: 'email.received',
            description: 'Email received',
            delivery: ['poll'],
            inputSchema: {
              type: 'object',
              required: ['mailbox'],
              properties: { mailbox: { type: 'string' } },
              additionalProperties: false,
            },
            payloadSchema: {
              type: 'object',
              required: ['mailbox'],
              properties: { mailbox: { type: 'string' } },
            },
          }],
        };
      }
      if (message.method === 'events/poll') {
        const mailbox = message.params.arguments.mailbox;
        calls.push({ mailbox, cursor: message.params.cursor });
        if (message.params.cursor === null) {
          const cursor = `${mailbox}:0`;
          cursors.set(mailbox, cursor);
          return {
            events: [],
            cursor,
            hasMore: false,
            nextPollMs: 1000,
          };
        }
        const cursor = `${mailbox}:1`;
        cursors.set(mailbox, cursor);
        return {
          events: [{
            eventId: `email-${mailbox}`,
            name: 'email.received',
            timestamp: '2026-09-25T10:00:00.000Z',
            data: { mailbox },
          }],
          cursor,
          hasMore: false,
          nextPollMs: 1000,
        };
      }
      throw new Error(`Unexpected method ${message.method}`);
    },
  };

  try {
    const runtime = await buildRuntime(dir, [
      connection('mail', 'mail-mcp', client),
    ]);
    await runtime.manager.discoverAll();

    for (const mailbox of ['sales', 'support']) {
      await runtime.control.createTrigger({
        definition: {
          triggerId: `mail-${mailbox}`,
          version: '1',
          clauses: [{
            id: 'mail',
            event: 'email.received',
            serverId: 'mail-mcp',
            arguments: { mailbox },
            where: [],
          }],
          expression: { kind: 'anyOf', refs: ['mail'] },
          withinMs: 60000,
          target: { runtime: 'test-runtime', kind: 'task', id: mailbox },
        },
        connectionIds: ['mail'],
        actor: { type: 'user', principal_id: 'user_1' },
        owner: { type: 'user', principal_id: 'user_1' },
      });
    }

    await runtime.manager.pollAll();
    await runtime.manager.pollAll();

    const states = runtime.store.listMcpClientStates('mail');
    assert.equal(states.length, 2);
    assert.deepEqual(
      states.map((state) => state.arguments.mailbox).sort(),
      ['sales', 'support'],
    );
    assert.equal(
      runtime.store.getMcpClientState(
        'mail',
        'email.received',
        { mailbox: 'sales' },
      ).cursor,
      'sales:1',
    );
    assert.equal(
      runtime.store.getMcpClientState(
        'mail',
        'email.received',
        { mailbox: 'support' },
      ).cursor,
      'support:1',
    );
    assert.equal(calls.filter((call) => call.mailbox === 'sales').length, 2);
    assert.equal(calls.filter((call) => call.mailbox === 'support').length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const delivery of ['push', 'webhook']) {
  test(`host-owned ${delivery} delivery feeds the same EventOccurrence pipeline`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), `ei-${delivery}-`));
    let closed = false;

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
              name: 'deploy.completed',
              description: 'Deployment completed',
              delivery: [delivery],
              inputSchema: {
                type: 'object',
                required: ['environment'],
                properties: { environment: { type: 'string' } },
              },
              payloadSchema: {
                type: 'object',
                required: ['environment'],
                properties: { environment: { type: 'string' } },
              },
            }],
          };
        }
        throw new Error(`Unexpected request in ${delivery} mode: ${message.method}`);
      },
    };

    const deliveryHook = async ({
      name,
      arguments: args,
      onActive,
      onEvent,
    }) => {
      assert.equal(name, 'deploy.completed');
      assert.deepEqual(args, { environment: 'staging' });
      await onActive({ cursor: 'delivery:0', truncated: false });
      await onEvent({
        eventId: `${delivery}-deploy-1`,
        name: 'deploy.completed',
        timestamp: '2026-09-25T10:05:00.000Z',
        data: { environment: 'staging' },
        cursor: 'delivery:1',
        _meta: { deliveredBy: delivery },
      });
      return {
        cursor: 'delivery:1',
        close: async () => {
          closed = true;
        },
      };
    };

    try {
      const runtime = await buildRuntime(dir, [
        createHostMcpEventsConnection({
          connectionId: `${delivery}-conn`,
          serverId: `${delivery}-mcp`,
          client,
          preferredDelivery: delivery,
          ...(delivery === 'push'
            ? { openEventStream: deliveryHook }
            : { createWebhookSubscription: deliveryHook }),
        }),
      ]);
      await runtime.manager.discoverAll();
      await runtime.control.createTrigger({
        definition: {
          triggerId: `${delivery}-trigger`,
          version: '1',
          clauses: [{
            id: 'deploy',
            event: 'deploy.completed',
            serverId: `${delivery}-mcp`,
            arguments: { environment: 'staging' },
            where: [],
          }],
          expression: { kind: 'anyOf', refs: ['deploy'] },
          withinMs: 60000,
          target: { runtime: 'test-runtime', kind: 'task', id: delivery },
        },
        connectionIds: [`${delivery}-conn`],
        actor: { type: 'user', principal_id: 'user_1' },
        owner: { type: 'user', principal_id: 'user_1' },
      });

      const result = await runtime.manager.pollConnection(`${delivery}-conn`);
      assert.equal(result[0].delivery, delivery);
      assert.equal(result[0].status, 'active');
      assert.equal(
        runtime.store.listTriggerMatches(`${delivery}-trigger`)[0].status,
        'matched',
      );
      const state = runtime.store.getMcpClientState(
        `${delivery}-conn`,
        'deploy.completed',
        { environment: 'staging' },
      );
      assert.equal(state.deliveryMode, delivery);
      assert.equal(state.cursor, 'delivery:1');
      await runtime.manager.detachConnection(`${delivery}-conn`);
      assert.equal(closed, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
