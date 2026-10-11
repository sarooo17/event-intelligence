import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TemporalDeadlineScheduler } from '../scripts/lib/temporal-deadline-scheduler.mjs';
import { TriggerInspector, simulateTrigger } from '../scripts/lib/trigger-inspector.mjs';

const startAt = '2026-10-11T10:00:00.000Z';
const dueAt = '2026-10-11T10:30:00.000Z';
const beforeDue = '2026-10-11T10:29:59.999Z';
const fixtureEvent = {
  traceId: 'clock-trace',
  sourceEventId: 'mail-event-1',
  name: 'email.received',
  serverId: 'test-provider',
  provider: 'synthetic',
  occurredAt: startAt,
  data: { thread: 'case-1', body: 'private-payload-must-not-leak' },
};

const definition = {
  triggerId: 'virtual-clock-restart-no-reply',
  version: '1',
  clauses: [
    { id: 'mail', event: 'email.received', serverId: 'test-provider', where: [] },
    { id: 'reply', event: 'email.replied', serverId: 'test-provider', where: [] },
  ],
  pattern: {
    root: {
      kind: 'absence',
      id: 'no-reply-in-30-minutes',
      child: { kind: 'event', ref: 'mail' },
      ref: 'reply',
      afterRef: 'mail',
      forMs: 30 * 60_000,
    },
  },
  withinMs: 60 * 60_000,
  target: { runtime: 'test-runtime', kind: 'task', id: 'no-real-callback' },
};

function project(inspection) {
  return {
    reason: inspection.why.code,
    matchStatus: inspection.match?.status ?? null,
    nextEvaluationAt: inspection.nextEvaluationAt,
    deadlineStatuses: inspection.deadlines.map(x => ({
      dueAt: x.dueAt,
      status: x.status,
    })),
    clauses: inspection.clauses.map(x => ({
      clause: x.clauseId,
      status: x.status,
      eventIds: x.evidence.map(e => e.sourceEventId),
    })),
  };
}

async function durableReferenceRun() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-virtual-durable-parity-'));
  let now = new Date(startAt);
  try {
    const firstStore = new PersistentEventStore(dir);
    await firstStore.init();
    const firstEngine = new CompositeTriggerEngine(firstStore, null, () => now);
    await firstEngine.register(definition);
    const ingested = await firstEngine.ingest(fixtureEvent);
    assert.equal(ingested[0].matched, false);
    assert.equal(ingested[0].match.status, 'partial');
    assert.equal(firstStore.listTemporalDeadlines({ status: 'pending' }).length, 1);
    assert.equal(firstStore.listTemporalDeadlines()[0].dueAt, dueAt);

    // Reopen the same durable data with a genuinely new engine and store,
    // not the simulation's process-local store and not a second provider.
    const secondStore = new PersistentEventStore(dir);
    const restored = await secondStore.init();
    assert.equal(restored.temporalDeadlines, 1);
    const secondEngine = new CompositeTriggerEngine(secondStore, null, () => now);
    const inspector = new TriggerInspector({ store: secondStore, now: () => now });
    const consumer = new CompositeEventConsumer({
      store: secondStore,
      triggerEngine: secondEngine,
      wakeCoordinators: new Map(),
    });
    const scheduler = new TemporalDeadlineScheduler({
      store: secondStore,
      compositeEventConsumer: consumer,
      now: () => now,
    });

    now = new Date(beforeDue);
    const early = await scheduler.runDue();
    assert.deepEqual(early, [], 'one millisecond before due must not fire');
    const pending = project(await inspector.inspect({
      triggerId: definition.triggerId, version: definition.version,
    }));
    assert.equal(pending.nextEvaluationAt, dueAt);
    assert.deepEqual(pending.deadlineStatuses, [{
      dueAt, status: 'pending',
    }]);

    now = new Date(dueAt);
    const outcomes = await scheduler.runDue();
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, 'fired');
    const after = project(await inspector.inspect({
      triggerId: definition.triggerId, version: definition.version,
    }));
    assert.equal(after.matchStatus, 'matched');
    // The inspector scopes deadlines to the *latest* match ID, while the
    // fired timer belongs to the earlier partial match ID. Verify the
    // authoritative durable deadline directly instead of demanding it in
    // the final match's narrow inspector projection.
    assert.equal(secondStore.listTemporalDeadlines()[0].status, 'fired');
    assert.deepEqual(after.deadlineStatuses, []);
    assert.deepEqual(await scheduler.runDue(), [],
      'replaying the exact virtual clock must not fire twice');
    return { pending, after };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('isolated virtual simulation agrees with durable restart at the exact deadline', async () => {
  const base = { definition, events: [fixtureEvent], startAt };
  const [pendingSim, dueSim, repeatSim] = await Promise.all([
    simulateTrigger({ ...base, until: beforeDue }),
    simulateTrigger({ ...base, until: dueAt }),
    simulateTrigger({ ...base, until: dueAt }),
  ]);
  assert.equal(pendingSim.isolated, true);
  assert.equal(dueSim.isolated, true);
  assert.deepEqual(dueSim, repeatSim,
    'same synthetic clock and input produce an identical simulation report');
  assert.equal(pendingSim.steps.length, 1);
  assert.equal(dueSim.steps.length, 2);
  assert.equal(dueSim.steps[1].type, 'timer');
  assert.equal(dueSim.steps[1].processingTime, dueAt);
  assert.equal(dueSim.steps[1].results[0].status, 'matched');

  const first = await durableReferenceRun();
  const second = await durableReferenceRun();
  assert.deepEqual(first, second,
    'the persisted restart path is independently reproducible');
  assert.deepEqual(first.pending, project(pendingSim.inspection),
    'simulation before the deadline must match a restarted persistent host');
  assert.deepEqual(first.after, project(dueSim.inspection),
    'simulation at the deadline must match a restarted persistent host');
  for (const view of [
    first.pending, first.after,
    project(pendingSim.inspection), project(dueSim.inspection),
  ]) {
    assert.doesNotMatch(JSON.stringify(view), /private-payload-must-not-leak/);
  }
});
