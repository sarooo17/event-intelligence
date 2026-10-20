import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';

const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integration = url ? test : test.skip;
const now = '2026-10-18T14:00:00.000Z';

function definition(id, version = '1') {
  return {
    triggerId: id, version,
    clauses: [{ id: 'c', event: 'performance.event',
      arguments: {}, where: [{ path: 'slot', op: 'eq', value: 7 }] }],
    pattern: { version: '2', root: { kind: 'event', ref: 'c' } },
    withinMs: 60000,
    lifecycle: { oneShot: false, cooldownMs: 0, completeOnGoal: false },
    target: { runtime: 'fixture-host', kind: 'task', id: 'effect-' + id },
  };
}
function event(eventId) {
  return {
    eventId, name: 'performance.event', timestamp: now,
    data: { slot: 7 },
  };
}

integration('PG indexed trigger lookup serves matched consumer and coordinator without full-list reads', async () => {
  const tablePrefix = 'ei_point_wake_' + randomBytes(5).toString('hex');
  const pool = new Pool({ connectionString: url, max: 4 });
  const isolated = new PostgresEventStore({
    pool: pool, dispatchPoolIdentity: pool, tablePrefix, scopeId: 'perf-tenant-A',
  });
  const neighbor = new PostgresEventStore({
    pool: pool, dispatchPoolIdentity: pool, tablePrefix, scopeId: 'perf-tenant-B',
  });
  const suffixes = ['metadata', 'leases', 'history', 'records', 'counters'];
  let deliveries = 0;
  try {
    await Promise.all([isolated.init(), neighbor.init()]);
    const a = definition('match-point-lookup');
    const b = definition('match-point-lookup', '2');
    await isolated.putTrigger(a);
    await isolated.putTrigger(b);
    await neighbor.putTrigger(definition('neighbor-only'));
    assert.equal((await isolated.getTrigger(a.triggerId, a.version)).version, '1');
    assert.equal((await isolated.getTrigger(b.triggerId, b.version)).version, '2');
    assert.equal(await isolated.getTrigger('neighbor-only', '1'), null);
    assert.equal(await neighbor.getTrigger(a.triggerId, '1'), null);
    assert.equal(await isolated.getTrigger('missing', '1'), null);

    // All real trigger-engine candidate/lifecycle reads remain enabled.
    // A read of every tenant trigger is forbidden after registration.
    const engine = new CompositeTriggerEngine(isolated);
    let pointCalls = 0;
    const pointRead = isolated.getTrigger.bind(isolated);
    isolated.getTrigger = async (...args) => {
      pointCalls++;
      return pointRead(...args);
    };
    isolated.listTriggers = () => {
      throw new Error('full trigger registry read on matched event/wake');
    };
    const wakeCoordinator = new CompositeWakeCoordinator({
      store: isolated, triggerEngine: engine,
      workerId: 'indexed-proof-worker',
      now: () => new Date(now),
      deliverer: async packet => {
        deliveries++;
        return { runtimeReceiptId: 'receipt:' + packet.wakeId };
      },
    });
    const consumer = new CompositeEventConsumer({
      store: isolated, triggerEngine: engine, wakeCoordinator,
    });
    const result = await consumer.ingestMcpOccurrence({
      event: event('indexed-event-1'), serverId: 'fixture-server',
      provider: 'benchmark-fixture', traceId: 'indexed-trace-1',
    });
    assert.equal(result.deliveries.length, 2,
      'both independently versioned active definitions must receive distinct wakes');
    assert.ok(result.deliveries.every(row => row.status === 'wake_delivered'));
    assert.equal(pointCalls, 6, 'consumer, coordinator and lifecycle each use an exact point lookup per matched version');
    assert.equal(deliveries, 2);

    const replay = await consumer.ingestMcpOccurrence({
      event: event('indexed-event-1'), serverId: 'fixture-server',
      provider: 'benchmark-fixture', traceId: 'indexed-trace-1',
    });
    assert.ok(replay.deliveries.every(row => row.status === 'already_fired'));
    assert.equal(deliveries, 2, 'replay never re-delivers host side effects');
    assert.equal(await isolated.verifyAudit(), true);
  } finally {
    try {
      for (const suffix of suffixes) {
        await pool.query('DROP TABLE IF EXISTS "' +
          tablePrefix + '_' + suffix + '" CASCADE');
      }
    } finally {
      await pool.end();
    }
  }
});
