import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';

const dbUrl = process.env.POSTGRES_URL;
const pg = dbUrl ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integration = dbUrl ? test : test.skip;
const name = 'github.issue.changed';
const source = {
  connectionId: 'cursor-boundary-connection',
  serverId: 'github-mcp-fixture',
  eventName: name,
  arguments: { repository: 'example/repo' },
  deliveryMode: 'poll',
};
const stamp = Date.now() - 1000;
const occurrence = (id, n) => ({
  eventId: id,
  name,
  timestamp: new Date(stamp + n).toISOString(),
  data: { repository: 'example/repo', issueNumber: 42, revision: n },
});
const intake = (consumer, event) => consumer.ingestMcpOccurrence({
  event,
  serverId: 'github-mcp-fixture', provider: 'fixture',
  subscriptionArguments: source.arguments,
  traceId: 'source:' + event.eventId,
});

function trigger() {
  return {
    triggerId: 'cursor-before-ack',
    version: '1',
    clauses: [{
      id: 'changed', event: name, serverId: 'github-mcp-fixture',
      arguments: source.arguments, where: [{
        path: 'repository', op: 'eq', value: 'example/repo',
      }],
    }],
    pattern: { version: '2', root: { kind: 'event', ref: 'changed' } },
    withinMs: 60000,
    lifecycle: {
      oneShot: false, cooldownMs: 0, completeOnGoal: false,
    },
    target: { runtime: 'host-fixture', kind: 'task', id: 'issue-turn' },
  };
}

integration('PostgreSQL worker pool loss after wake, before MCP cursor ack replays idempotently', async () => {
  const prefix = 'ei_cursor_' + randomBytes(5).toString('hex');
  const scopeId = 'tenant-cursor-boundary';
  let firstPool = new Pool({
    connectionString: dbUrl, max: 2,
    query_timeout: 5000, statement_timeout: 5000,
  });
  let secondPool = null;
  let deliverCount = 0;
  const deliver = async packet => {
    deliverCount++;
    assert.ok(packet.trigger_match_id);
    return { runtimeReceiptId: 'host-receipt-' + packet.trigger_match_id };
  };
  const make = pool => {
    const store = new PostgresEventStore({ pool: pool, dispatchPoolIdentity: pool, scopeId, tablePrefix: prefix });
    const engine = new CompositeTriggerEngine(store);
    const coordinator = new CompositeWakeCoordinator({
      store, triggerEngine: engine,
      workerId: 'cursor-boundary-host',
      deliverer: deliver,
    });
    return {
      store, engine,
      consumer: new CompositeEventConsumer({
        store, triggerEngine: engine, wakeCoordinator: coordinator,
      }),
    };
  };
  try {
    const first = make(firstPool);
    await first.store.init();
    await first.engine.register(trigger());
    await first.store.putMcpClientState({
      ...source, cursor: 'opaque-cursor-before-event', truncated: false,
    });

    // Commit the match + host wake receipt but deliberately DO NOT
    // advance source cursor (the crash boundary).
    const originalEvent = occurrence('github-source-1', 1);
    const initial = await intake(first.consumer, originalEvent);
    assert.equal(initial.results.filter(row => row.matched).length, 1);
    assert.equal(initial.deliveries.length, 1);
    assert.equal(initial.deliveries[0].status, 'wake_delivered');
    const persistedWakeId = initial.deliveries[0].wakeId;
    const persistedReceipt = initial.deliveries[0].runtimeReceiptId;
    assert.ok(persistedWakeId && persistedReceipt);
    assert.equal(deliverCount, 1);
    const before = await first.store.getMcpClientState(
      source.connectionId, name, source.arguments,
    );
    assert.equal(before.cursor, 'opaque-cursor-before-event');

    // Kill the worker's physical database sessions, not the OS process.
    await firstPool.end();
    firstPool = null;
    secondPool = new Pool({
      connectionString: dbUrl, max: 2,
      query_timeout: 5000, statement_timeout: 5000,
    });
    const restarted = make(secondPool);
    await restarted.store.init();
    const recoveredCursor = await restarted.store.getMcpClientState(
      source.connectionId, name, source.arguments,
    );
    assert.equal(recoveredCursor.cursor, 'opaque-cursor-before-event');
    const priorReceipt = await restarted.store.getWakeDelivery(persistedWakeId);
    assert.equal(priorReceipt.status, 'delivered');
    assert.equal(priorReceipt.runtimeReceiptId, persistedReceipt);

    // Old cursor causes exact same provider ID/arguments to be replayed.
    const replay = await intake(restarted.consumer, originalEvent);
    assert.equal(replay.results.filter(row => row.matched).length, 1);
    assert.equal(replay.results[0].match.status, 'fired');
    assert.equal(replay.results[0].match.matchId,
      initial.results[0].match.matchId);
    assert.equal(replay.deliveries[0].status, 'already_fired');
    assert.equal(replay.deliveries[0].wakeId, persistedWakeId);
    assert.equal(deliverCount, 1,
      'replayed provider occurrence must not trigger another host effect');

    // The new worker explicitly checkpoints after verifying replay.
    const ack = await restarted.store.putMcpClientState({
      ...recoveredCursor, ...source,
      cursor: 'opaque-cursor-after-event', truncated: false,
    });
    assert.equal(ack.cursor, 'opaque-cursor-after-event');
    const fresh = await intake(restarted.consumer, occurrence('github-source-2', 2));
    assert.equal(fresh.deliveries.length, 1);
    assert.equal(fresh.deliveries[0].status, 'wake_delivered');
    assert.notEqual(fresh.deliveries[0].wakeId, persistedWakeId);
    assert.equal(deliverCount, 2);
    const finalReceipt = await restarted.store.getWakeDelivery(
      fresh.deliveries[0].wakeId,
    );
    assert.equal(finalReceipt?.status, 'delivered');
    assert.equal(finalReceipt?.attemptCount, 1);
    const finalCursor = await restarted.store.getMcpClientState(
      source.connectionId, name, source.arguments,
    );
    assert.equal(finalCursor.cursor, 'opaque-cursor-after-event');
    assert.equal((await restarted.store.listTriggerMatches('cursor-before-ack'))
      .filter(row => row.status === 'fired').length, 2);
  } finally {
    const cleanup = secondPool ?? firstPool ?? new Pool({ connectionString: dbUrl, max: 2 });
    try {
      for (const suffix of ['metadata', 'leases', 'history', 'records', 'counters']) {
        await cleanup.query(
          'DROP TABLE IF EXISTS "' + prefix + '_' + suffix + '" CASCADE',
        );
      }
    } finally {
      for (const pool of new Set([firstPool, secondPool, cleanup].filter(Boolean))) {
        await pool.end();
      }
    }
  }
});
