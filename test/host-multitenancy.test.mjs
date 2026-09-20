import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createEventIntelligenceHost,
  PersistentEventStore,
} from '../scripts/host-integration.mjs';

function scopedEventClient(eventId) {
  let delivered = false;
  return {
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
            name: 'invoice.submitted',
            delivery: ['poll'],
            payloadSchema: {
              type: 'object',
              required: ['invoiceId'],
              properties: {
                invoiceId: { type: 'string' },
              },
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
              eventId,
              name: 'invoice.submitted',
              timestamp: '2026-09-20T13:00:00.000Z',
              data: { invoiceId: 'INV-001' },
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

function triggerDefinition() {
  return {
    triggerId: 'same-trigger-id',
    version: '1',
    clauses: [{
      id: 'invoice',
      event: 'invoice.submitted',
      serverId: 'shared-erp',
      where: [],
    }],
    expression: { kind: 'anyOf', refs: ['invoice'] },
    withinMs: 60000,
    lifecycle: { oneShot: true },
    target: {
      runtime: 'test-runtime',
      kind: 'task',
      id: 'same-target',
    },
  };
}

test('one host isolates tenant scopes across sources, triggers, matches, wakes and restart', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-scopes-'));
  const wakes = [];

  const registry = {
    async listConnections() {
      return [
        {
          id: 'erp-a',
          serverId: 'shared-erp',
          scopeId: 'tenant-a',
          client: scopedEventClient('event-a'),
          pollIntervalMs: 300000,
        },
        {
          id: 'erp-b',
          serverId: 'shared-erp',
          scopeId: 'tenant-b',
          client: scopedEventClient('event-b'),
          pollIntervalMs: 300000,
        },
      ];
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
      return {
        runtimeReceiptId: `receipt:${packet.scope_id}:${packet.wake_id}`,
      };
    },
  });

  try {
    const tenantA = await host.scope('tenant-a');
    const tenantB = await host.scope('tenant-b');

    assert.deepEqual(host.eventSources, []);
    assert.deepEqual(
      tenantA.eventSources.map((source) => source.connectionId),
      ['erp-a'],
    );
    assert.deepEqual(
      tenantB.eventSources.map((source) => source.connectionId),
      ['erp-b'],
    );

    for (const [tenant, connectionId, ownerId] of [
      [tenantA, 'erp-a', 'user-a'],
      [tenantB, 'erp-b', 'user-b'],
    ]) {
      await tenant.triggerControl.createTrigger({
        definition: triggerDefinition(),
        connectionIds: [connectionId],
        actor: { type: 'user', principal_id: ownerId, tenant_id: ownerId },
        owner: { type: 'user', principal_id: ownerId, tenant_id: ownerId },
      });
    }

    assert.equal(tenantA.store.listTriggers().length, 1);
    assert.equal(tenantB.store.listTriggers().length, 1);
    assert.equal(host.store.listTriggers().length, 0);
    assert.equal(tenantA.store.listTriggers()[0].triggerId, 'same-trigger-id');
    assert.equal(tenantB.store.listTriggers()[0].triggerId, 'same-trigger-id');

    await host.runtime.mcpEventsClient.pollAll();
    await host.runtime.mcpEventsClient.pollAll();

    assert.deepEqual(
      wakes.map((packet) => packet.scope_id).sort(),
      ['tenant-a', 'tenant-b'],
    );
    assert.equal(
      tenantA.store.listTriggerMatches('same-trigger-id')[0].sourceEvents[0].sourceEventId,
      'event-a',
    );
    assert.equal(
      tenantB.store.listTriggerMatches('same-trigger-id')[0].sourceEvents[0].sourceEventId,
      'event-b',
    );
    assert.equal(host.store.listTriggerMatches('same-trigger-id').length, 0);

    assert.deepEqual(
      tenantA.mcpStatus().map((entry) => entry.connectionId),
      ['erp-a'],
    );
    assert.deepEqual(
      tenantB.mcpStatus().map((entry) => entry.connectionId),
      ['erp-b'],
    );


    // Isolation is enforced by scoped store partitions, not by post-query
    // owner filtering. Verify the less-obvious observability/cursor surfaces
    // cannot see across tenant boundaries either.
    assert.deepEqual(
      tenantA.store.listEventSources().map((source) => source.connectionId),
      ['erp-a'],
    );
    assert.deepEqual(
      tenantB.store.listEventSources().map((source) => source.connectionId),
      ['erp-b'],
    );
    assert.deepEqual(
      tenantA.store.listMcpClientStates().map((state) => state.connectionId),
      ['erp-a'],
    );
    assert.deepEqual(
      tenantB.store.listMcpClientStates().map((state) => state.connectionId),
      ['erp-b'],
    );
    assert.deepEqual(
      tenantA.store.listMcpOccurrencesAfter(0).map((record) => record.event.eventId),
      ['event-a'],
    );
    assert.deepEqual(
      tenantB.store.listMcpOccurrencesAfter(0).map((record) => record.event.eventId),
      ['event-b'],
    );
    assert.equal(host.store.listEventSources().length, 0);
    assert.equal(host.store.listMcpClientStates().length, 0);
    assert.equal(host.store.listMcpOccurrencesAfter(0).length, 0);

    const tenantAAudit = JSON.stringify(tenantA.store.listAudit());
    const tenantBAudit = JSON.stringify(tenantB.store.listAudit());
    assert.match(tenantAAudit, /erp-a|same-trigger-id/);
    assert.doesNotMatch(tenantAAudit, /event-b|erp-b/);
    assert.match(tenantBAudit, /erp-b|same-trigger-id/);
    assert.doesNotMatch(tenantBAudit, /event-a|erp-a/);
    assert.equal(host.store.listAudit().length, 0);

    const wakeA = wakes.find((packet) => packet.scope_id === 'tenant-a');
    const wakeB = wakes.find((packet) => packet.scope_id === 'tenant-b');
    assert.ok(wakeA);
    assert.ok(wakeB);
    assert.ok(tenantA.store.latestWake(wakeA.wake_id));
    assert.equal(tenantB.store.latestWake(wakeA.wake_id), null);
    assert.ok(tenantB.store.latestWake(wakeB.wake_id));
    assert.equal(tenantA.store.latestWake(wakeB.wake_id), null);
  } finally {
    await host.close();
  }

  const restored = await createEventIntelligenceHost({
    dataDir,
    env: {
      TYPESAFE_API_KEY: '',
      RUNTIME_WAKE_TARGETS_JSON: '{}',
      TEMPORAL_TICK_MS: '100000',
    },
  });
  try {
    assert.deepEqual(restored.loadedScopes(), [
      'default',
      'tenant-a',
      'tenant-b',
    ]);
    assert.equal(
      (await restored.scope('tenant-a')).store.listTriggers()[0].triggerId,
      'same-trigger-id',
    );
    assert.equal(
      (await restored.scope('tenant-b')).store.listTriggers()[0].triggerId,
      'same-trigger-id',
    );
  } finally {
    await restored.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('host accepts an injected persistent store without changing default behavior', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-store-injection-'));
  const store = new PersistentEventStore(dataDir);
  const host = await createEventIntelligenceHost({
    store,
    env: {
      TYPESAFE_API_KEY: '',
      RUNTIME_WAKE_TARGETS_JSON: '{}',
      TEMPORAL_TICK_MS: '100000',
    },
  });

  try {
    assert.equal(host.store, store);
    const scoped = await host.scope('tenant-custom');
    assert.notEqual(scoped.store, store);
    assert.deepEqual(host.loadedScopes(), ['default', 'tenant-custom']);
  } finally {
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
