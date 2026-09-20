import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';
import { EventProcessor } from '../scripts/lib/event-processor.mjs';
import { buildGenericRuntimeWakePacket } from '../scripts/lib/generic-runtime-wake.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';

function event({ id, name, at, serverId, provider, data }) {
  return {
    traceId: `trace_${id}`,
    sourceEventId: id,
    name,
    occurredAt: at,
    serverId,
    provider,
    data,
  };
}

test('composite match wakes a generic runtime once, is handled, and replay cannot refire', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-ei-runtime-wake-'));

  try {
    const store = new PersistentEventStore(dir);
    await store.init();

    const triggerEngine = new CompositeTriggerEngine(store);
    await triggerEngine.register({
      protocolVersion: '0.1.0',
      schemaVersion: 'trigger.v0.1',
      triggerId: 'issue-and-mail',
      version: '1',
      clauses: [
        {
          id: 'issue',
          event: 'github.issue.opened',
          where: [{ path: 'repository', op: 'eq', value: 'acme/app' }],
        },
        {
          id: 'mail',
          event: 'email.received',
          where: [{ path: 'from', op: 'eq', value: 'pippo@example.com' }],
        },
      ],
      expression: {
        kind: 'allOf',
        refs: ['issue', 'mail'],
      },
      withinMs: 24 * 60 * 60 * 1000,
      target: {
        runtime: 'runtime-probe',
        kind: 'task',
        id: 'issue-report',
      },
    });

    const issue = await triggerEngine.ingest(
      event({
        id: 'gh_delivery_1',
        name: 'github.issue.opened',
        at: '2026-09-18T08:00:00.000Z',
        serverId: 'github-mcp-events',
        provider: 'github',
        data: {
          repository: 'acme/app',
          number: 42,
          title: 'Signup fails',
        },
      }),
    );
    assert.equal(issue[0].match.status, 'partial');

    const mailEvent = event({
      id: 'gmail_history_2',
      name: 'email.received',
      at: '2026-09-18T09:00:00.000Z',
      serverId: 'gmail-mcp-events',
      provider: 'gmail',
      data: {
        from: 'pippo@example.com',
        subject: 'Issue 42',
      },
    });

    const matched = await triggerEngine.ingest(mailEvent);
    assert.equal(matched[0].match.status, 'matched');

    let deliveredPackets = 0;
    const coordinator = new CompositeWakeCoordinator({
      store,
      triggerEngine,
      deliverer: async (packet) => {
        deliveredPackets += 1;
        assert.equal(packet.version, '1.0.0');
        assert.equal(packet.trigger_match_id, matched[0].match.matchId);
        assert.equal(packet.target.runtime, 'runtime-probe');
        assert.equal(packet.target.kind, 'task');
        assert.equal(packet.source_event_refs.length, 2);
        assert.deepEqual(
          packet.source_event_refs.map((ref) => ref.server_id),
          ['github-mcp-events', 'gmail-mcp-events'],
        );
        assert.equal('data' in packet.source_event_refs[0], false);
        assert.equal('data' in packet.source_event_refs[1], false);
        return {
          runtimeReceiptId: 'runtime-probe:receipt_1',
          status: 'completed',
          duplicate: false,
        };
      },
    });

    const delivered = await coordinator.deliverMatched(matched[0].match);
    assert.equal(delivered.status, 'wake_delivered');
    assert.equal(delivered.wake.status, 'delivered');
    assert.equal(deliveredPackets, 1);

    const firedMatch = store.listTriggerMatches('issue-and-mail')[0];
    assert.equal(firedMatch.status, 'fired');
    assert.equal(firedMatch.firedWakeId, delivered.wake.wakeId);

    const processor = new EventProcessor({ store });
    const handled = await processor.acknowledgeWake(
      delivered.wake.wakeId,
      delivered.wake.runtimeReceiptId,
    );
    assert.equal(handled.status, 'handled');

    const replay = await triggerEngine.ingest(mailEvent);
    assert.equal(replay[0].match.status, 'fired');

    const replayDelivery = await coordinator.deliverMatched(replay[0].match);
    assert.equal(replayDelivery.status, 'already_fired');
    assert.equal(replayDelivery.wake.status, 'handled');
    assert.equal(deliveredPackets, 1);
    assert.equal(await store.verifyAudit(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generic wake packet bounds source refs to the latest 50 events', () => {
  const sourceEvents = Array.from({ length: 55 }, (_, index) => ({
    clauseId: 'mail',
    traceId: `trace_${index}`,
    sourceEventId: `event_${index}`,
    eventName: 'email.received',
    occurredAt: new Date(Date.UTC(2026, 8, 18, 8, index)).toISOString(),
    serverId: 'gmail-mcp-events',
    data: { index },
  }));

  const packet = buildGenericRuntimeWakePacket({
    wakeId: 'wake_many',
    match: {
      protocolVersion: '0.1.0',
      schemaVersion: 'trigger.v0.1',
      matchId: 'tm_many',
      triggerId: 'many-events',
      triggerVersion: '1',
      status: 'matched',
      correlationKey: null,
      openedAt: sourceEvents[0].occurredAt,
      expiresAt: '2026-09-19T08:00:00.000Z',
      updatedAt: sourceEvents.at(-1).occurredAt,
      sourceEvents,
      correlationDecision: null,
      firedWakeId: null,
    },
    definition: {
      protocolVersion: '0.1.0',
      schemaVersion: 'trigger.v0.1',
      triggerId: 'many-events',
      version: '1',
      clauses: [{ id: 'mail', event: 'email.received', where: [] }],
      expression: { kind: 'count', ref: 'mail', atLeast: 55 },
      withinMs: 86_400_000,
      target: { runtime: 'runtime-probe', kind: 'task', id: 'report' },
    },
  });

  assert.equal(packet.source_event_refs.length, 50);
  assert.equal(packet.source_event_refs[0].event_id, 'event_5');
  assert.equal(packet.source_event_refs.at(-1).event_id, 'event_54');
});
