import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';

function githubEvent({
  id,
  name,
  timestamp,
  number,
}) {
  return {
    eventId: id,
    name,
    timestamp,
    data: {
      repository: 'sarooo17/mcp-event-intelligence',
      number,
      title: 'FC-010.1 two-event GitHub test',
      labels: [],
      action: name.split('.').at(-1),
    },
    cursor: null,
  };
}

test('accepted MCP GitHub occurrences automatically satisfy a composite trigger', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-composite-fanin-'));

  try {
    const store = new PersistentEventStore(dir);
    await store.init();

    const triggerEngine = new CompositeTriggerEngine(store);
    await triggerEngine.register({
      protocolVersion: '0.1.0',
      schemaVersion: 'trigger.v0.1',
      triggerId: 'github-open-close-same-issue',
      version: '1',
      clauses: [
        {
          id: 'opened',
          event: 'github.issue.opened',
          where: [
            {
              path: 'repository',
              op: 'eq',
              value: 'sarooo17/mcp-event-intelligence',
            },
          ],
        },
        {
          id: 'closed',
          event: 'github.issue.closed',
          where: [
            {
              path: 'repository',
              op: 'eq',
              value: 'sarooo17/mcp-event-intelligence',
            },
          ],
        },
      ],
      expression: {
        kind: 'allOf',
        refs: ['opened', 'closed'],
      },
      withinMs: 60 * 60 * 1000,
      correlation: {
        deterministic: {
          kind: 'same_value',
          fields: [
            { ref: 'opened', path: 'number' },
            { ref: 'closed', path: 'number' },
          ],
        },
      },
      target: {
        runtime: 'test',
        kind: 'goal',
        id: 'github-two-event-test',
      },
    });

    const consumer = new CompositeEventConsumer({
      store,
      triggerEngine,
    });

    const opened = await consumer.ingestMcpOccurrence({
      event: githubEvent({
        id: 'delivery_open',
        name: 'github.issue.opened',
        timestamp: '2026-09-18T16:00:00.000Z',
        number: 123,
      }),
      serverId: 'github-mcp-events',
      provider: 'github',
      traceId: 'trace_open',
    });

    assert.equal(opened.results.length, 1);
    assert.equal(opened.results[0].match.status, 'partial');
    assert.equal(opened.results[0].matched, false);
    assert.equal(opened.deliveries.length, 0);

    const closed = await consumer.ingestMcpOccurrence({
      event: githubEvent({
        id: 'delivery_close',
        name: 'github.issue.closed',
        timestamp: '2026-09-18T16:10:00.000Z',
        number: 123,
      }),
      serverId: 'github-mcp-events',
      provider: 'github',
      traceId: 'trace_close',
    });

    assert.equal(closed.results.length, 1);
    assert.equal(closed.results[0].matched, true);
    assert.equal(closed.results[0].match.status, 'matched');
    assert.equal(closed.results[0].match.correlationKey, '123');
    assert.deepEqual(
      closed.results[0].match.sourceEvents.map((event) => event.eventName),
      ['github.issue.opened', 'github.issue.closed'],
    );
    assert.equal(closed.deliveries.length, 1);
    assert.equal(closed.deliveries[0].status, 'runtime_unconfigured');

    const replay = await consumer.ingestMcpOccurrence({
      event: githubEvent({
        id: 'delivery_close',
        name: 'github.issue.closed',
        timestamp: '2026-09-18T16:10:00.000Z',
        number: 123,
      }),
      serverId: 'github-mcp-events',
      provider: 'github',
      traceId: 'trace_close',
    });

    assert.equal(replay.results.length, 1);
    assert.equal(replay.results[0].match.matchId, closed.results[0].match.matchId);
    assert.equal(store.listTriggerMatches('github-open-close-same-issue').length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('same event type for another issue cannot join the existing correlation key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-composite-key-'));

  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const triggerEngine = new CompositeTriggerEngine(store);
    await triggerEngine.register({
      protocolVersion: '0.1.0',
      schemaVersion: 'trigger.v0.1',
      triggerId: 'same-issue-only',
      version: '1',
      clauses: [
        { id: 'opened', event: 'github.issue.opened', where: [] },
        { id: 'closed', event: 'github.issue.closed', where: [] },
      ],
      expression: { kind: 'allOf', refs: ['opened', 'closed'] },
      withinMs: 60 * 60 * 1000,
      correlation: {
        deterministic: {
          kind: 'same_value',
          fields: [
            { ref: 'opened', path: 'number' },
            { ref: 'closed', path: 'number' },
          ],
        },
      },
      target: { runtime: 'test', kind: 'goal', id: 'same-issue' },
    });

    const consumer = new CompositeEventConsumer({ store, triggerEngine });

    await consumer.ingestMcpOccurrence({
      event: githubEvent({
        id: 'open_10',
        name: 'github.issue.opened',
        timestamp: '2026-09-18T16:00:00.000Z',
        number: 10,
      }),
      serverId: 'github-mcp-events',
      provider: 'github',
      traceId: 'trace_10',
    });

    const wrongClose = await consumer.ingestMcpOccurrence({
      event: githubEvent({
        id: 'close_11',
        name: 'github.issue.closed',
        timestamp: '2026-09-18T16:05:00.000Z',
        number: 11,
      }),
      serverId: 'github-mcp-events',
      provider: 'github',
      traceId: 'trace_11',
    });

    assert.equal(wrongClose.results[0].matched, false);
    assert.equal(store.listTriggerMatches('same-issue-only').length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
