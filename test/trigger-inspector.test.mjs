import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import {
  TriggerInspector,
  simulateTrigger,
} from '../scripts/lib/trigger-inspector.mjs';

function event(name, id, at, data = {}) {
  return {
    traceId: `trace_${id}`,
    sourceEventId: id,
    name,
    serverId: 'server',
    provider: 'test',
    occurredAt: at,
    data,
  };
}

const target = {
  runtime: 'runtime-probe',
  kind: 'task',
  id: 'inspect-task',
};

test('inspector explains the exact missing clause without exposing raw event data', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc019-partial-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(
      store,
      null,
      () => new Date('2026-09-18T12:01:00.000Z'),
    );
    await engine.register({
      triggerId: 'release-check',
      version: '1',
      clauses: [
        { id: 'merged', event: 'pr.merged', serverId: 'server', where: [] },
        { id: 'deployed', event: 'deploy.succeeded', serverId: 'server', where: [] },
      ],
      expression: { kind: 'allOf', refs: ['merged', 'deployed'] },
      withinMs: 3600000,
      target,
    });

    await engine.ingest(
      event('pr.merged', 'pr_1', '2026-09-18T12:00:00.000Z', {
        secret: 'must-not-leak',
        number: 218,
      }),
    );

    const inspector = new TriggerInspector({
      store,
      now: () => new Date('2026-09-18T12:01:00.000Z'),
    });
    const view = inspector.inspect({
      triggerId: 'release-check',
      version: '1',
    });

    assert.equal(view.why.code, 'waiting_for_event_clauses');
    assert.deepEqual(view.why.missingClauses, ['deployed']);
    assert.equal(
      view.clauses.find((clause) => clause.clauseId === 'merged').status,
      'satisfied',
    );
    assert.equal(
      view.clauses.find((clause) => clause.clauseId === 'deployed').status,
      'waiting',
    );
    assert.equal(view.lineage.evidence[0].sourceEventId, 'pr_1');
    assert.equal('data' in view.lineage.evidence[0], false);
    assert.equal(JSON.stringify(view).includes('must-not-leak'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('inspector exposes absence deadline, remaining state and next evaluation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc019-deadline-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(
      store,
      null,
      () => new Date('2026-09-18T17:20:00.000Z'),
    );
    await engine.register({
      triggerId: 'no-reply',
      version: '1',
      clauses: [
        { id: 'mail', event: 'email.received', serverId: 'server', where: [] },
        { id: 'reply', event: 'email.replied', serverId: 'server', where: [] },
      ],
      expression: { kind: 'anyOf', refs: ['mail'] },
      temporal: [{
        id: 'wait-until-20',
        kind: 'absence',
        ref: 'reply',
        afterRef: 'mail',
        untilLocalTime: '20:00',
        timezone: 'Europe/Rome',
      }],
      withinMs: 4 * 3600000,
      target,
    });

    await engine.ingest(
      event(
        'email.received',
        'mail_1',
        '2026-09-18T17:20:00.000Z',
        { threadId: 't1' },
      ),
    );

    const view = new TriggerInspector({
      store,
      now: () => new Date('2026-09-18T17:30:00.000Z'),
    }).inspect({
      triggerId: 'no-reply',
      version: '1',
    });

    assert.equal(view.why.code, 'waiting_for_temporal_conditions');
    assert.equal(view.nextEvaluationAt, '2026-09-18T18:00:00.000Z');
    assert.equal(view.temporal.conditions[0].status, 'pending');
    assert.equal(view.deadlines[0].status, 'pending');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('inspector traces a fired trigger to refs and runtime receipt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc019-fired-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const now = () => new Date('2026-09-18T12:00:00.000Z');
    const engine = new CompositeTriggerEngine(store, null, now);
    await engine.register({
      triggerId: 'fired-proof',
      version: '1',
      lifecycle: { oneShot: true },
      clauses: [
        { id: 'ready', event: 'release.ready', serverId: 'server', where: [] },
      ],
      expression: { kind: 'anyOf', refs: ['ready'] },
      withinMs: 3600000,
      target,
    });

    const result = await engine.ingest(
      event('release.ready', 'release_1', now().toISOString(), {
        internalPayload: 'not-for-inspector',
      }),
    );
    const coordinator = new CompositeWakeCoordinator({
      store,
      triggerEngine: engine,
      now,
      packetBuilder: ({ wakeId, match }) => ({
        version: '1',
        wakeId,
        matchId: match.matchId,
      }),
      deliverer: async (packet) => ({
        runtimeReceiptId: `runtime:${packet.wakeId}`,
      }),
    });
    await coordinator.deliverMatched(result[0].match);

    const view = new TriggerInspector({ store, now }).inspect({
      triggerId: 'fired-proof',
      version: '1',
    });

    assert.equal(view.match.status, 'fired');
    assert.equal(view.lifecycle.status, 'completed');
    assert.equal(view.why.code, 'trigger_completed');
    assert.match(view.wake.runtimeReceiptId, /^runtime:wake_/);
    assert.deepEqual(
      view.lineage.evidence.map((ref) => ref.sourceEventId),
      ['release_1'],
    );
    assert.equal(JSON.stringify(view).includes('not-for-inspector'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('simulation deterministically advances durable time without mutating live state', async () => {
  const definition = {
    triggerId: 'simulation-no-reply',
    version: '1',
    clauses: [
      { id: 'mail', event: 'email.received', serverId: 'server', where: [] },
      { id: 'reply', event: 'email.replied', serverId: 'server', where: [] },
    ],
    expression: { kind: 'anyOf', refs: ['mail'] },
    temporal: [{
      id: 'absence-30m',
      kind: 'absence',
      ref: 'reply',
      afterRef: 'mail',
      forMs: 30 * 60 * 1000,
    }],
    withinMs: 2 * 3600000,
    target,
  };
  const events = [
    event(
      'email.received',
      'sim_mail',
      '2026-09-18T12:00:00.000Z',
      { body: 'private input not returned as evidence' },
    ),
  ];

  const input = {
    definition,
    events,
    until: '2026-09-18T12:31:00.000Z',
    order: 'provided',
  };
  const first = await simulateTrigger(input);
  const second = await simulateTrigger(input);

  assert.equal(first.isolated, true);
  assert.equal(first.steps[0].results[0].status, 'partial');
  assert.equal(first.steps[1].type, 'timer');
  assert.equal(first.steps[1].results[0].status, 'matched');
  assert.equal(first.inspection.match.status, 'matched');
  assert.equal(first.inspection.why.code, 'matched_waiting_delivery');
  assert.equal(
    JSON.stringify(first.inspection).includes('private input'),
    false,
  );

  assert.deepEqual(
    {
      steps: first.steps,
      inspection: first.inspection,
      auditRecords: first.auditRecords,
    },
    {
      steps: second.steps,
      inspection: second.inspection,
      auditRecords: second.auditRecords,
    },
  );
});
