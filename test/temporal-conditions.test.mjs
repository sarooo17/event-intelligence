import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import {
  localDateTimeToUtc,
} from '../dist/src/composite/temporal.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TemporalDeadlineScheduler } from '../scripts/lib/temporal-deadline-scheduler.mjs';

function event(name, id, occurredAt, data = {}) {
  return {
    traceId: `trace_${id}`,
    sourceEventId: id,
    name,
    serverId: 'test-server',
    provider: 'test',
    occurredAt,
    data,
  };
}

function baseTarget() {
  return { runtime: 'test-runtime', kind: 'task', id: 'temporal-proof' };
}

test('calendar-aware condition accepts mail before 20:00 Europe/Rome and rejects after', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc017-calendar-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(
      store,
      null,
      () => new Date('2026-09-18T17:31:00.000Z'),
    );

    await engine.register({
      triggerId: 'mail-before-20',
      version: '1',
      clauses: [{
        id: 'mail',
        event: 'email.received',
        serverId: 'test-server',
        where: [],
      }],
      expression: { kind: 'anyOf', refs: ['mail'] },
      temporal: [{
        id: 'business-time',
        kind: 'calendar',
        ref: 'mail',
        timezone: 'Europe/Rome',
        before: '20:00',
        weekdays: [5],
        dates: ['2026-09-18'],
      }],
      withinMs: 3600000,
      target: baseTarget(),
    });

    const before = await engine.ingest(
      event(
        'email.received',
        'mail_before',
        '2026-09-18T17:30:00.000Z',
      ),
    );
    assert.equal(before[0].match.status, 'matched');

    const afterDir = await mkdtemp(path.join(os.tmpdir(), 'fc017-calendar-after-'));
    try {
      const afterStore = new PersistentEventStore(afterDir);
      await afterStore.init();
      const afterEngine = new CompositeTriggerEngine(
        afterStore,
        null,
        () => new Date('2026-09-18T18:31:00.000Z'),
      );
      await afterEngine.register({
        triggerId: 'mail-before-20-after-case',
        version: '1',
        clauses: [{
          id: 'mail',
          event: 'email.received',
          serverId: 'test-server',
          where: [],
        }],
        expression: { kind: 'anyOf', refs: ['mail'] },
        temporal: [{
          id: 'business-time',
          kind: 'calendar',
          ref: 'mail',
          timezone: 'Europe/Rome',
          before: '20:00',
          weekdays: [5],
          dates: ['2026-09-18'],
        }],
        withinMs: 3600000,
        target: baseTarget(),
      });

      const after = await afterEngine.ingest(
        event(
          'email.received',
          'mail_after',
          '2026-09-18T18:30:00.000Z',
        ),
      );
      assert.equal(after[0].match.status, 'expired');
    } finally {
      await rm(afterDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('absence until 20:00 survives restart and fires from durable timer with no provider event', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc017-absence-'));
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
        {
          id: 'mail',
          event: 'email.received',
          serverId: 'test-server',
          where: [],
        },
        {
          id: 'reply',
          event: 'email.replied',
          serverId: 'test-server',
          where: [],
        },
      ],
      expression: { kind: 'anyOf', refs: ['mail'] },
      temporal: [{
        id: 'reply-deadline',
        kind: 'absence',
        ref: 'reply',
        afterRef: 'mail',
        untilLocalTime: '20:00',
        timezone: 'Europe/Rome',
      }],
      withinMs: 4 * 3600000,
      correlation: {
        deterministic: {
          kind: 'same_value',
          fields: [
            { ref: 'mail', path: 'threadId' },
            { ref: 'reply', path: 'threadId' },
          ],
        },
      },
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
    assert.equal(
      secondStore.listTemporalDeadlines()[0].status,
      'fired',
    );

    const replay = await scheduler.runDue();
    assert.deepEqual(replay, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reply before deadline blocks absence trigger and cancels timer', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc017-cancel-'));
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
      expression: { kind: 'anyOf', refs: ['mail'] },
      temporal: [{
        id: 'no-reply',
        kind: 'absence',
        ref: 'reply',
        afterRef: 'mail',
        forMs: 30 * 60 * 1000,
      }],
      withinMs: 3600000,
      correlation: {
        deterministic: {
          kind: 'same_value',
          fields: [
            { ref: 'mail', path: 'threadId' },
            { ref: 'reply', path: 'threadId' },
          ],
        },
      },
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

    assert.equal(reply[0].match.status, 'expired');
    assert.equal(
      store.listTemporalDeadlines()[0].status,
      'cancelled',
    );
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

test('debounce, threshold, rate and distinct temporal guards evaluate over match history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc017-operators-'));
  let now = new Date('2026-09-18T12:00:00.000Z');
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store, null, () => now);

    await engine.register({
      triggerId: 'operator-pack',
      version: '1',
      clauses: [{
        id: 'failure',
        event: 'ci.failed',
        serverId: 'test-server',
        where: [],
      }],
      expression: { kind: 'count', ref: 'failure', atLeast: 1 },
      temporal: [
        { id: 'threshold', kind: 'threshold', ref: 'failure', atLeast: 3 },
        { id: 'rate', kind: 'rate', ref: 'failure', atLeast: 3, perMs: 60000 },
        { id: 'distinct', kind: 'distinct', ref: 'failure', path: 'runner', atLeast: 2 },
        { id: 'debounce', kind: 'debounce', ref: 'failure', forMs: 10000 },
      ],
      withinMs: 3600000,
      target: baseTarget(),
    });

    await engine.ingest(event('ci.failed', 'f1', '2026-09-18T12:00:00.000Z', { runner: 'a' }));
    now = new Date('2026-09-18T12:00:05.000Z');
    await engine.ingest(event('ci.failed', 'f2', '2026-09-18T12:00:05.000Z', { runner: 'a' }));
    now = new Date('2026-09-18T12:00:09.000Z');
    const third = await engine.ingest(event('ci.failed', 'f3', '2026-09-18T12:00:09.000Z', { runner: 'b' }));
    assert.equal(third[0].match.status, 'partial');

    now = new Date('2026-09-18T12:00:20.000Z');
    const consumer = new CompositeEventConsumer({
      store,
      triggerEngine: engine,
      wakeCoordinators: new Map(),
    });
    const scheduler = new TemporalDeadlineScheduler({
      store,
      compositeEventConsumer: consumer,
      now: () => now,
    });
    await scheduler.runDue();

    const latest = store.listTriggerMatches('operator-pack')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    assert.equal(latest.status, 'matched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
