import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createEventIntelligenceHost,
} from '../scripts/host-integration.mjs';

function eventClient() {
  let delivered = false;
  return {
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
            name: 'build.completed',
            delivery: ['poll'],
            payloadSchema: {
              type: 'object',
              properties: { repository: { type: 'string' } },
            },
          }],
        };
      }
      if (message.method === 'events/poll') {
        if (!message.params?.cursor) {
          return { events: [], cursor: 'ready', hasMore: false };
        }
        if (!delivered) {
          delivered = true;
          return {
            events: [{
              eventId: 'build-1',
              name: 'build.completed',
              timestamp: '2026-09-19T13:00:00.000Z',
              data: { repository: 'acme/app' },
            }],
            cursor: 'done',
            hasMore: false,
          };
        }
        return { events: [], cursor: 'done', hasMore: false };
      }
      throw new Error(`Unexpected method ${message.method}`);
    },
  };
}

function toolsOnlyClient() {
  return {
    getServerCapabilities() {
      return { tools: {} };
    },
    async request(message) {
      throw new Error(`Tools-only client should not receive ${message.method}`);
    },
  };
}

test('host registry auto-discovers event MCPs, ignores tools-only MCPs and wakes multiple agents', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-host-registry-'));
  const wakes = [];
  let registryEntries = [
    { id: 'github', serverId: 'github-mcp', client: eventClient(), pollIntervalMs: 300000 },
    { id: 'tools-only', serverId: 'tools-mcp', client: toolsOnlyClient() },
  ];
  const registry = {
    async listConnections() {
      return registryEntries;
    },
  };

  const host = await createEventIntelligenceHost({
    dataDir,
    env: {
      TYPESAFE_API_KEY: '',
      RUNTIME_WAKE_TARGETS_JSON: '{}',
      TEMPORAL_TICK_MS: '100000',
    },
    mcpRegistry: registry,
    wake: async (packet) => {
      wakes.push(packet);
      return { runtimeReceiptId: `host-receipt:${packet.target.id}` };
    },
  });

  try {
    assert.deepEqual(
      host.eventSources.map((source) => source.eventName),
      ['build.completed'],
    );
    assert.equal(host.mcpStatus().length, 1);
    assert.equal(host.mcpStatus()[0].connectionId, 'github');

    for (const agentId of ['agent-a', 'agent-b']) {
      await host.triggerControl.createTrigger({
        definition: {
          triggerId: `host-build-done-${agentId}`,
          version: '1',
          clauses: [{
            id: 'build',
            event: 'build.completed',
            serverId: 'github-mcp',
            where: [],
          }],
          expression: { kind: 'anyOf', refs: ['build'] },
          withinMs: 60000,
          lifecycle: { oneShot: true },
          target: {
            runtime: 'agent-harness',
            kind: 'task',
            id: agentId,
          },
        },
        connectionIds: ['github'],
        actor: { type: 'agent', principal_id: agentId },
        owner: { type: 'user', principal_id: 'host-user' },
        confirmationId: `confirm-${agentId}`,
      });
    }

    await host.runtime.mcpEventsClient.pollAll();
    await host.runtime.mcpEventsClient.pollAll();

    assert.deepEqual(
      wakes.map((packet) => packet.target.id).sort(),
      ['agent-a', 'agent-b'],
    );
    assert.equal(
      host.store.listTriggerMatches('host-build-done-agent-a')[0].status,
      'fired',
    );
    assert.equal(
      host.store.listTriggerMatches('host-build-done-agent-b')[0].status,
      'fired',
    );

    registryEntries = [
      { id: 'github', serverId: 'github-mcp', client: eventClient(), pollIntervalMs: 300000 },
    ];
    const reconnect = await host.refreshMcpRegistry();
    assert.ok(
      reconnect.some(
        (entry) =>
          entry.connectionId === 'github' &&
          entry.status === 'reattached',
      ),
    );
    assert.equal(host.eventSources.length, 1);

    registryEntries = [];
    const refresh = await host.refreshMcpRegistry();
    assert.ok(
      refresh.some(
        (entry) =>
          entry.connectionId === 'github' &&
          entry.status === 'detached',
      ),
    );
    assert.equal(host.mcpStatus().length, 0);
    assert.equal(host.eventSources.length, 0);
  } finally {
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
