import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TriggerControlPlane } from '../scripts/lib/trigger-control-plane.mjs';

function evt(id, at, name = 'signal', data = {}) {
  return {
    traceId: `trace_${id}`,
    sourceEventId: id,
    name,
    serverId: 'server',
    occurredAt: at,
    data,
  };
}

function definition({
  triggerId = 'lifecycle',
  version = '1',
  lifecycle = {},
} = {}) {
  return {
    triggerId,
    version,
    clauses: [{ id: 'signal', event: 'signal', serverId: 'server', where: [] }],
    expression: { kind: 'anyOf', refs: ['signal'] },
    withinMs: 3600000,
    lifecycle,
    target: { runtime: 'runtime-probe', kind: 'task', id: 'task' },
  };
}

function coordinator(store, engine, now) {
  return new CompositeWakeCoordinator({
    store,
    triggerEngine: engine,
    now,
    packetBuilder: ({ wakeId, match }) => ({
      version: '1',
      wakeId,
      matchId: match.matchId,
    }),
    deliverer: async (packet) => ({
      runtimeReceiptId: `receipt:${packet.wakeId}`,
    }),
  });
}

test('one-shot trigger completes after one runtime receipt and stays completed across restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc018-oneshot-'));
  let now = new Date('2026-09-18T12:00:00.000Z');
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store, null, () => now);
    await engine.register(definition({ lifecycle: { oneShot: true } }));

    const matched = await engine.ingest(evt('one', now.toISOString()));
    assert.equal(matched[0].match.status, 'matched');
    await coordinator(store, engine, () => now).deliverMatched(matched[0].match);

    const state = store.getTriggerState('lifecycle', '1');
    assert.equal(state.status, 'completed');
    assert.equal(state.fireCount, 1);
    assert.equal(state.lastFiredAt, now.toISOString());

    const restoredStore = new PersistentEventStore(dir);
    await restoredStore.init();
    const restoredEngine = new CompositeTriggerEngine(
      restoredStore,
      null,
      () => new Date('2026-09-18T12:10:00.000Z'),
    );
    const ignored = await restoredEngine.ingest(
      evt('two', '2026-09-18T12:10:00.000Z'),
    );
    assert.deepEqual(ignored, []);
    assert.equal(
      restoredStore.getTriggerState('lifecycle', '1').status,
      'completed',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cooldown suppresses immediate reactivation and maxFirings completes later', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc018-cooldown-'));
  let now = new Date('2026-09-18T12:00:00.000Z');
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store, null, () => now);
    await engine.register(definition({
      triggerId: 'repeatable',
      lifecycle: {
        cooldownMs: 60000,
        maxFirings: 2,
      },
    }));

    const first = await engine.ingest(evt('r1', now.toISOString()));
    await coordinator(store, engine, () => now).deliverMatched(first[0].match);
    assert.equal(store.getTriggerState('repeatable', '1').fireCount, 1);
    assert.equal(store.getTriggerState('repeatable', '1').status, 'active');

    now = new Date('2026-09-18T12:00:20.000Z');
    assert.deepEqual(
      await engine.ingest(evt('r2', now.toISOString())),
      [],
    );

    now = new Date('2026-09-18T12:01:01.000Z');
    const second = await engine.ingest(evt('r3', now.toISOString()));
    assert.equal(second[0].match.status, 'matched');
    await coordinator(store, engine, () => now).deliverMatched(second[0].match);

    const completed = store.getTriggerState('repeatable', '1');
    assert.equal(completed.fireCount, 2);
    assert.equal(completed.status, 'completed');

    now = new Date('2026-09-18T12:03:00.000Z');
    assert.deepEqual(
      await engine.ingest(evt('r4', now.toISOString())),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('expired lifecycle never creates a match or wake', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc018-expiry-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(
      store,
      null,
      () => new Date('2026-09-18T12:00:00.000Z'),
    );
    await engine.register(definition({
      triggerId: 'expired-trigger',
      lifecycle: {
        expiresAt: '2026-09-18T11:59:00.000Z',
      },
    }));

    const result = await engine.ingest(
      evt('expired-event', '2026-09-18T12:00:00.000Z'),
    );
    assert.deepEqual(result, []);
    assert.equal(
      store.getTriggerState('expired-trigger', '1').status,
      'expired',
    );
    assert.equal(store.listTriggerMatches('expired-trigger').length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('versioned update retires partial state and deadlines; stale expectedVersion is rejected', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc018-update-'));
  let now = new Date('2026-09-18T12:00:00.000Z');
  const actor = { type: 'user', principal_id: 'user_1' };
  const owner = { type: 'user', principal_id: 'user_1' };

  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store, null, () => now);
    const control = new TriggerControlPlane({
      store,
      triggerEngine: engine,
      now: () => now,
    });

    await control.registerEventSource({
      sourceId: 'source_mail',
      connectionId: 'conn',
      serverId: 'server',
      eventName: 'mail.received',
      enabled: true,
      delivery: ['poll'],
    }, actor);
    await control.registerEventSource({
      sourceId: 'source_reply',
      connectionId: 'conn',
      serverId: 'server',
      eventName: 'mail.replied',
      enabled: true,
      delivery: ['poll'],
    }, actor);

    const v1 = {
      triggerId: 'versioned',
      version: '1',
      clauses: [
        { id: 'mail', event: 'mail.received', serverId: 'server', where: [] },
        { id: 'reply', event: 'mail.replied', serverId: 'server', where: [] },
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
      target: { runtime: 'runtime-probe', kind: 'task', id: 'task' },
    };

    await control.createTrigger({
      definition: v1,
      connectionIds: ['conn'],
      actor,
      owner,
    });

    const partial = await engine.ingest(
      evt('mail-v1', now.toISOString(), 'mail.received'),
    );
    assert.equal(partial[0].match.status, 'partial');
    assert.equal(store.listTemporalDeadlines({ status: 'pending' }).length, 1);

    const v2 = {
      ...v1,
      version: '2',
      temporal: [],
    };

    const updated = await control.updateTrigger({
      triggerId: 'versioned',
      expectedVersion: '1',
      definition: v2,
      actor,
      owner,
    });

    assert.equal(updated.previous.state.status, 'completed');
    assert.equal(updated.state.status, 'active');
    assert.equal(
      store.listTemporalDeadlines()[0].status,
      'cancelled',
    );
    const oldLatest = store.listTriggerMatchHistory(partial[0].match.matchId).at(-1);
    assert.equal(oldLatest.status, 'expired');

    await assert.rejects(
      () => control.updateTrigger({
        triggerId: 'versioned',
        expectedVersion: '1',
        definition: { ...v2, version: '3' },
        actor,
        owner,
      }),
      (error) => error.code === 'TRIGGER_VERSION_CONFLICT',
    );

    const deleted = await control.deleteTrigger({
      triggerId: 'versioned',
      version: '2',
      actor,
      owner,
    });
    assert.equal(deleted.state.status, 'deleted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
