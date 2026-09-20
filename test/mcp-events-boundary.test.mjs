import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ExperimentalMcpEventsServer,
} from '../dist/src/mcpEvents/server.js';
import {
  mcpOccurrenceToCorrelatableEvent,
} from '../dist/src/mcpEvents/consumer.js';
import {
  ingestGitHubMcpEvent,
  registerGitHubMcpEvents,
} from '../scripts/lib/github-mcp-events-adapter.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';

function issueEvent(id, title, timestamp = '2026-09-18T09:00:00.000Z') {
  return {
    eventId: id,
    name: 'github.issue.opened',
    timestamp,
    data: {
      repository: 'acme/app',
      number: Number(id.replace(/\D/g, '') || 1),
      title,
      bodyPreview: '',
      labels: ['onboarding'],
      sender: 'sarooo17',
      action: 'opened',
      url: null,
    },
    cursor: null,
  };
}

function request(id, method, params) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

test('modern discovery advertises experimental Events and list exposes GitHub descriptors', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-events-discover-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const server = new ExperimentalMcpEventsServer(store);
    registerGitHubMcpEvents(server);

    const discover = await server.handleRequest(
      request(1, 'server/discover'),
    );
    assert.deepEqual(discover.result.supportedVersions, ['2026-07-28']);
    assert.equal(
      discover.result.capabilities.experimental[
        'io.modelcontextprotocol.experimental/events'
      ].status,
      'draft',
    );

    const listed = await server.handleRequest(request(2, 'events/list'));
    const opened = listed.result.events.find(
      (event) => event.name === 'github.issue.opened',
    );
    assert.ok(opened);
    assert.deepEqual(opened.delivery, ['poll']);
    assert.ok(opened.inputSchema.properties.repository);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('null cursor starts now; later GitHub event is polled once with structured filters', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-events-poll-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const server = new ExperimentalMcpEventsServer(store);
    registerGitHubMcpEvents(server);

    const initial = await server.handleRequest(
      request(1, 'events/poll', {
        name: 'github.issue.opened',
        arguments: {
          repository: 'acme/app',
          label: 'onboarding',
        },
        cursor: null,
      }),
    );

    assert.equal(initial.result.events.length, 0);

    const receipt = await ingestGitHubMcpEvent(
      store,
      issueEvent('delivery_1', 'Signup is blocked'),
    );
    assert.equal(receipt.accepted, true);

    const polled = await server.handleRequest(
      request(2, 'events/poll', {
        name: 'github.issue.opened',
        arguments: {
          repository: 'acme/app',
          label: 'onboarding',
        },
        cursor: initial.result.cursor,
      }),
    );

    assert.equal(polled.result.events.length, 1);
    assert.equal(polled.result.events[0].eventId, 'delivery_1');

    const empty = await server.handleRequest(
      request(3, 'events/poll', {
        name: 'github.issue.opened',
        arguments: { repository: 'acme/app' },
        cursor: polled.result.cursor,
      }),
    );
    assert.equal(empty.result.events.length, 0);

    const duplicate = await ingestGitHubMcpEvent(
      store,
      issueEvent('delivery_1', 'Signup is blocked'),
    );
    assert.equal(duplicate.accepted, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cursor and occurrence log survive restart and support bounded draining', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-events-restart-'));

  try {
    const firstStore = new PersistentEventStore(dir);
    await firstStore.init();
    const firstServer = new ExperimentalMcpEventsServer(firstStore);
    registerGitHubMcpEvents(firstServer);

    const baseline = firstServer.poll({
      name: 'github.issue.opened',
      cursor: null,
    });

    await ingestGitHubMcpEvent(
      firstStore,
      issueEvent('delivery_2', 'First issue', '2026-09-18T09:01:00.000Z'),
    );
    await ingestGitHubMcpEvent(
      firstStore,
      issueEvent('delivery_3', 'Second issue', '2026-09-18T09:02:00.000Z'),
    );

    const secondStore = new PersistentEventStore(dir);
    const restored = await secondStore.init();
    assert.equal(restored.mcpOccurrences, 2);

    const secondServer = new ExperimentalMcpEventsServer(secondStore);
    registerGitHubMcpEvents(secondServer);

    const firstBatch = secondServer.poll({
      name: 'github.issue.opened',
      cursor: baseline.cursor,
      maxEvents: 1,
    });

    assert.equal(firstBatch.events.length, 1);
    assert.equal(firstBatch.hasMore, true);
    assert.equal(firstBatch.nextPollMs, 0);

    const secondBatch = secondServer.poll({
      name: 'github.issue.opened',
      cursor: firstBatch.cursor,
      maxEvents: 1,
    });

    assert.equal(secondBatch.events.length, 1);
    assert.equal(secondBatch.events[0].eventId, 'delivery_3');
    assert.equal(secondBatch.hasMore, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('downstream conversion preserves only MCP event semantics, not webhook transport', async () => {
  const normalized = await mcpOccurrenceToCorrelatableEvent(
    issueEvent('delivery_4', 'Activation problem'),
    {
      traceId: 'trace_mcp_delivery_4',
      provider: 'github',
    },
  );

  assert.equal(normalized.sourceEventId, 'delivery_4');
  assert.equal(normalized.name, 'github.issue.opened');
  assert.equal(normalized.data.title, 'Activation problem');
  assert.match(normalized.payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(normalized, 'webhook'), false);
});
