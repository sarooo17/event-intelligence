import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { localDateTimeToUtc } from '../dist/src/composite/temporal.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TemporalDeadlineScheduler } from '../scripts/lib/temporal-deadline-scheduler.mjs';

function event(name, id, at, data = {}) {
  return {
    traceId: `trace_${id}`,
    sourceEventId: id,
    name,
    serverId: 'test-server',
    provider: 'test',
    occurredAt: at,
    data,
  };
}

function baseTarget() {
  return {
    runtime: 'runtime-probe',
    kind: 'task',
    id: 'temporal-test',
  };
}

function absencePattern({ untilLocalTime, timezone, forMs } = {}) {
  return {
    root: {
      kind: 'absence',
      id: 'no-reply',
      child: { kind: 'event', ref: 'mail' },
      ref: 'reply',
      afterRef: 'mail',
      ...(forMs ? { forMs } : {}),
      ...(untilLocalTime ? { untilLocalTime } : {}),
      ...(timezone ? { timezone } : {}),
    },
    partitionBy: [{
      key: 'thread',
      fields: [
        { ref: 'mail', path: 'threadId' },
        { ref: 'reply', path: 'threadId' },
      ],
    }],
  };
}

test('calendar Pattern accepts mail before 20:00 Europe/Rome and rejects after', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-calendar-'));
  const afterDir = await mkdtemp(path.join(os.tmpdir(), 'ei-calendar-after-'));

  try {
    const definition = {
      triggerId: 'mail-before-20',
      version: '1',
      clauses: [{
        id: 'mail',
        event: 'email.received',
        serverId: 'test-server',
        where: [],
      }],
      pattern: {
        root: {
          kind: 'calendar',
          child: { kind: 'event', ref: 'mail' },
          ref: 'mail',
          timezone: 'Europe/Rome',
          before: '20:00',
          weekdays: [5],
          dates: ['2026-09-18'],
        },
      },
      withinMs: 3600000,
      target: baseTarget(),
    };

    const beforeStore = new PersistentEventStore(dir);
    await beforeStore.init();
    const beforeEngine = new CompositeTriggerEngine(beforeStore);
    await beforeEngine.register(definition);
    const before = await beforeEngine.ingest(
      event('email.received', 'mail_before', '2026-09-18T17:30:00.000Z'),
    );
    assert.equal(before.some((entry) => entry.matched), true);

    const afterStore = new PersistentEventStore(afterDir);
    await afterStore.init();
    const afterEngine = new CompositeTriggerEngine(afterStore);
    await afterEngine.register(definition);
    const after = await afterEngine.ingest(
      event('email.received', 'mail_after', '2026-09-18T18:30:00.000Z'),
    );
    assert.equal(after.some((entry) => entry.matched), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(afterDir, { recursive: true, force: true });
  }
});

test('absence until 20:00 survives restart and fires from durable timer with no provider event', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-absence-'));
  let now = new Date('2026-09-18T17:20:00.000Z');

  try {
    const firstStore = new PersistentEventStore(dir);
    await firstStore.init();
    const firstEngine = new CompositeTriggerEngine(
      firstStore,
      null,
      () => now,
    );

    await firstEngine.register({
      triggerId: 'no-reply-by-20',
      version: '1',
      clauses: [
        { id: 'mail', event: 'email.received', serverId: 'test-server', where: [] },
        { id: 'reply', event: 'email.replied', serverId: 'test-server', where: [] },
      ],
      pattern: absencePattern({
        untilLocalTime: '20:00',
        timezone: 'Europe/Rome',
      }),
      withinMs: 4 * 3600000,
      target: baseTarget(),
    });

    const partial = await firstEngine.ingest(
      event(
        'email.received',
        'mail_1',
        '2026-09-18T17:20:00.000Z',
        { threadId: 'thread_1' },
      ),
    );
    assert.equal(partial[0].match.status, 'partial');

    const pending = firstStore.listTemporalDeadlines({ status: 'pending' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].dueAt, '2026-09-18T18:00:00.000Z');

    now = new Date('2026-09-18T18:01:00.000Z');

    const secondStore = new PersistentEventStore(dir);
    const restored = await secondStore.init();
    assert.equal(restored.temporalDeadlines, 1);

    const secondEngine = new CompositeTriggerEngine(
      secondStore,
      null,
      () => now,
    );
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

    const outcomes = await scheduler.runDue();
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, 'fired');

    const latest = secondStore.listTriggerMatches('no-reply-by-20')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    assert.equal(latest.status, 'matched');
    assert.equal(latest.patternState.completedAt, '2026-09-18T18:00:00.000Z');
    assert.equal(secondStore.listTemporalDeadlines()[0].status, 'fired');

    const replay = await scheduler.runDue();
    assert.deepEqual(replay, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reply before deadline blocks absence Pattern and cancels timer', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-absence-cancel-'));
  let now = new Date('2026-09-18T17:20:00.000Z');

  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store, null, () => now);

    await engine.register({
      triggerId: 'reply-cancels',
      version: '1',
      clauses: [
        { id: 'mail', event: 'email.received', serverId: 'test-server', where: [] },
        { id: 'reply', event: 'email.replied', serverId: 'test-server', where: [] },
      ],
      pattern: absencePattern({ forMs: 30 * 60 * 1000 }),
      withinMs: 3600000,
      target: baseTarget(),
    });

    await engine.ingest(
      event(
        'email.received',
        'mail_cancel',
        '2026-09-18T17:20:00.000Z',
        { threadId: 'thread_cancel' },
      ),
    );

    now = new Date('2026-09-18T17:35:00.000Z');
    const reply = await engine.ingest(
      event(
        'email.replied',
        'reply_cancel',
        '2026-09-18T17:35:00.000Z',
        { threadId: 'thread_cancel' },
      ),
    );

    assert.equal(reply.some((entry) => entry.matched), false);
    assert.equal(store.listTemporalDeadlines()[0].status, 'cancelled');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('timezone conversion follows Europe/Rome DST rules', () => {
  assert.equal(
    localDateTimeToUtc(
      { year: 2026, month: 9, day: 18 },
      '20:00',
      'Europe/Rome',
    ).toISOString(),
    '2026-09-18T18:00:00.000Z',
  );

  assert.equal(
    localDateTimeToUtc(
      { year: 2026, month: 10, day: 25 },
      '20:00',
      'Europe/Rome',
    ).toISOString(),
    '2026-10-25T19:00:00.000Z',
  );
});
