import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { WakeRetryScheduler } from '../scripts/lib/wake-retry-scheduler.mjs';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';

const pgUrl = process.env.POSTGRES_URL;
const { Pool } = pgUrl ? await import('pg') : { Pool: null };
const integration = pgUrl ? test : test.skip;
const tables = ['metadata', 'leases', 'history', 'records', 'counters'];

function trigger(id, lifecycle = {}) {
  return {
    triggerId: id, version: '1',
    clauses: [{ id: 'c', event: 'fixture.recovery.expiration',
      arguments: {}, where: [{path:'slot',op:'eq',value:7}] }],
    pattern: { version: '2', root: { kind: 'event', ref: 'c' } },
    lifecycle, withinMs: 60000,
    target: { runtime:'fixture-host', kind:'task', id },
  };
}
async function fixture(body, { max = 6 } = {}) {
  const prefix = 'ei_orphan_gates_' + randomBytes(5).toString('hex');
  const pool = new Pool({ connectionString: pgUrl, max,
    query_timeout: 5000, statement_timeout: 5000 });
  const store = new PostgresEventStore({ pool, tablePrefix: prefix, scopeId: 'scope-recovery' });
  try {
    await store.init();
    return await body({ store, pool, prefix });
  } finally {
    try {
      await pool.query('DROP TABLE IF EXISTS ' +
        tables.map(name => '"' + prefix + '_' + name + '"').join(', ') + ' CASCADE');
    } finally {
      await pool.end();
    }
  }
}
integration('expired/lease-ended orphan cannot reach host even with lazily active persisted state', async () => fixture(async ({ store }) => {
  const horizon = new Date(Date.now() + 60000);
  const expire = trigger('expire-before-recovery', { expiresAt: horizon.toISOString() });
  const lease = trigger('lease-before-recovery', { leaseUntil: horizon.toISOString() });
  const engine = new CompositeTriggerEngine(store);
  await engine.register(expire);
  await engine.register(lease);
  const event = { eventId: 'orphan-deadline-1', name: 'fixture.recovery.expiration',
    timestamp: new Date().toISOString(), data: { slot: 7 } };
  const result = await new CompositeEventConsumer({ store, triggerEngine: engine })
    .ingestMcpOccurrence({ event, provider: 'test-source',
      serverId: 'test-source', traceId: 'deadline-test' });
  assert.equal(result.deliveries.length, 2);
  assert.ok(result.deliveries.every(x => x.status === 'runtime_unconfigured'));
  const matches = result.results.filter(x => x.matched);
  assert.equal(matches.length, 2);
  assert.equal((await store.getTriggerState(expire.triggerId, '1')).status, 'active');
  assert.equal((await store.getTriggerState(lease.triggerId, '1')).status, 'active');
  const scheduler = new WakeRetryScheduler({
    store, now: () => new Date(horizon.getTime() + 1000),
    resolveCoordinator: () => { throw new Error('deadline must never dispatch'); },
  });
  const recovered = await scheduler.runDue();
  assert.equal(recovered.filter(x => x.status === 'recovery_not_authorized').length, 2);
  assert.equal((await store.listDueWakeDeliveries(new Date(horizon.getTime()+1000).toISOString())).length, 0);
  assert.equal(await store.verifyAudit(), true);
}));

integration('concurrent lifecycle revocation waits for actual PG dispatch callback and no later host work starts', async () => fixture(async ({ store }) => {
  await store.putTrigger(trigger('dispatch-fence'));
  let started, release;
  const callbackEntered = new Promise(resolve => { started = resolve; });
  const callbackWait = new Promise(resolve => { release = resolve; });
  const callback = store.withTriggerDispatchFence(
    'dispatch-fence', '1', new Date().toISOString(), async () => {
      started();
      await callbackWait;
      return 'host-effect-finished';
    },
  );
  await callbackEntered;
  let pauseCommitted = false;
  const pause = store.setTriggerState('dispatch-fence', '1', 'paused')
    .then(x => { pauseCommitted = true; return x; });
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(pauseCommitted, false,
    'pause cannot commit while already-authorized host callback holds dispatch lock');
  release();
  assert.deepEqual(await callback, { authorized: true, value: 'host-effect-finished' });
  assert.equal((await pause).status, 'paused');
  let hostAttempts = 0;
  const after = await store.withTriggerDispatchFence(
    'dispatch-fence', '1', new Date().toISOString(),
    async () => { hostAttempts++; return 'forbidden'; },
  );
  assert.equal(after.authorized, false);
  assert.equal(hostAttempts, 0);
  assert.equal((await store.getTriggerState('dispatch-fence', '1')).status, 'paused');
  const lifecycleAttempt = await store.setTriggerState(
    'dispatch-fence', '1', 'active',
    { type: 'system', principal_id: 'event-intelligence:lifecycle' },
    { fireCount: 1 },
  );
  assert.equal(lifecycleAttempt.status, 'paused',
    'post-receipt system lifecycle cannot resurrect revocation');
  assert.equal((await store.getTriggerState('dispatch-fence', '1')).status, 'paused');
}));

integration('existing PG store requires explicit online indexes, and cannot scan orphan history without them', async () => fixture(async ({ store, pool, prefix }) => {
  await store.putTrigger(trigger('existing-tenant'));
  for (const suffix of ['_records_orphan_status_idx', '_records_wake_match_idx']) {
    await pool.query('DROP INDEX "' + prefix + suffix + '"');
  }
  await assert.rejects(
    () => store.listOrphanedMatchedWakeCandidates(),
    error => error?.code === 'EVENT_INTELLIGENCE_ORPHAN_RECOVERY_INDEX_REQUIRED',
  );
  const migrated = await store.migrateOrphanRecoveryIndexes();
  assert.equal(migrated.ok, true);
  assert.equal(migrated.indexes.length, 2);
  assert.deepEqual(await store.listOrphanedMatchedWakeCandidates(), []);
  await store.assertOrphanRecoveryIndexes();
  // An index with the right name/keys but an EXTRA predicate is NOT usable
  // for the recovery anti-join. Reject it instead of silently allowing an
  // unbounded history scan.
  await pool.query('DROP INDEX "' + prefix + '_records_wake_match_idx"');
  await pool.query(
    'CREATE INDEX "' + prefix + '_records_wake_match_idx" ON "' +
    prefix + '_records" (scope_id, (payload->>\'matchId\'))' +
    " WHERE kind='wake_delivery' AND (payload->>'disabled')='false'",
  );
  await assert.rejects(
    () => store.assertOrphanRecoveryIndexes(),
    error => error?.code === 'EVENT_INTELLIGENCE_ORPHAN_RECOVERY_INDEX_REQUIRED',
  );
  assert.equal(await store.verifyAudit(), true);
}));

integration('one-shot simultaneous matched wakes serialize host plus durable lifecycle finalization', async () => fixture(async ({ store }) => {
  const definition = trigger('one-shot-race', { oneShot: true });
  const engine = new CompositeTriggerEngine(store);
  await engine.register(definition);
  const consumer = new CompositeEventConsumer({ store, triggerEngine: engine });
  const matches = [];
  for (const i of [1, 2]) {
    const result = await consumer.ingestMcpOccurrence({
      event: { eventId: 'race-event-' + i, name: 'fixture.recovery.expiration',
        timestamp: new Date(Date.now() + i).toISOString(), data: { slot: 7 } },
      provider: 'test-source', serverId: 'test-source', traceId: 'race-' + i,
    });
    assert.equal(result.deliveries[0]?.status, 'runtime_unconfigured');
    matches.push(result.results.find(row => row.matched)?.match);
  }
  assert.ok(matches.every(Boolean));
  assert.notEqual(matches[0].matchId, matches[1].matchId);
  let effects = 0;
  const coordinator = workerId => new CompositeWakeCoordinator({
    store, triggerEngine: new CompositeTriggerEngine(store), workerId,
    deliverer: async packet => {
      // Canonical host identity; different matches have different wake_id.
      const current = await store.getTriggerState('one-shot-race', '1');
      assert.equal(current.status, 'active');
      effects++;
      return { runtimeReceiptId: 'host:' + packet.wake_id };
    },
  });
  const [a, b] = await Promise.all([
    coordinator('contender-one').deliverMatched(matches[0]),
    coordinator('contender-two').deliverMatched(matches[1]),
  ]);
  assert.equal([a, b].filter(x => x.status === 'wake_delivered').length, 1,
    'only one of two different one-shot matches may deliver its host effect');
  assert.equal(effects, 1);
  const current = await store.getTriggerState('one-shot-race', '1');
  assert.equal(current.status, 'completed');
  assert.equal(current.fireCount, 1);
  assert.deepEqual(current.dispatchReservations, [],
    'successful one-shot finalization must clear its durable wake reservation');
  assert.equal(await store.verifyAudit(), true);
}, { max: 3 }));

integration('fenced callback with same-store lookup and another waiter does not saturate a 3-connection pool', async () => fixture(async ({ store }) => {
  await store.putTrigger(trigger('pool-safety'));
  let start, release;
  const entered = new Promise(resolve => { start = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const first = store.withTriggerDispatchFence('pool-safety', '1',
    new Date().toISOString(), async () => {
      start();
      await blocked;
      assert.ok(await store.getTrigger('pool-safety', '1'),
        'callback needs a second PG connection while fence is held');
      return 'first';
    });
  await entered;
  const second = store.withTriggerDispatchFence('pool-safety', '1',
    new Date().toISOString(), async () => {
      assert.ok(await store.getTriggerState('pool-safety', '1'));
      return 'second';
    });
  release();
  const outcomes = await Promise.all([first, second]);
  assert.deepEqual(outcomes.map(x => x.authorized), [true, true]);
}, { max: 3 }));

integration('pool fairness enforces bounded capacity even when many fenced callbacks queue', async () => fixture(async ({ store }) => {
  for (let i = 0; i < 8; i++) await store.putTrigger(trigger('capacity-' + i));
  let active = 0, maximum = 0, completed = 0;
  let releaseFirst;
  let firstEntered;
  const firstStarted = new Promise(resolve => { firstEntered = resolve; });
  const firstMayExit = new Promise(resolve => { releaseFirst = resolve; });
  const operation = i => store.withTriggerDispatchFence(
    'capacity-' + i, '1', new Date().toISOString(), async () => {
      active++;
      maximum = Math.max(maximum, active);
      if (i === 0) {
        firstEntered();
        await firstMayExit;
      } else {
        // On a max=2 PostgreSQL pool exactly ONE connection must stay
        // reserved for this callback's own store query. A semaphore
        // handoff can never admit a later entrant before the queued one.
        assert.ok(await store.getTrigger('capacity-' + i, '1'));
      }
      await new Promise(resolve => setImmediate(resolve));
      completed++;
      active--;
      return i;
    },
  );
  const first = operation(0);
  await firstStarted;
  const rest = Array.from({ length: 7 }, (_, i) => operation(i + 1));
  releaseFirst();
  const out = await Promise.all([first, ...rest]);
  assert.equal(maximum, 1,
    'bounded admission must never give the second of two pool slots to a fence waiter');
  assert.equal(completed, 8);
  assert.deepEqual(out.map(x => x.value), [0,1,2,3,4,5,6,7]);
}, { max: 2 }));

integration('one-shot slot remains durably reserved when worker dies after host callback but before markFired', async () => fixture(async ({ store, prefix }) => {
  await store.putTrigger(trigger('reserved-one-shot', { oneShot: true }));
  let effects = 0;
  const invoke = (onStore, wakeId) => onStore.withTriggerDispatchFence(
    'reserved-one-shot', '1', new Date().toISOString(),
    async () => { effects++; return 'host-effect'; }, { wakeId },
  );
  const first = await invoke(store, 'wake-original');
  assert.equal(first.authorized, true);
  assert.equal(effects, 1);
  const saved = await store.getTriggerState('reserved-one-shot', '1');
  assert.equal(saved.fireCount, 0, 'simulates a real crash before markFired');
  assert.deepEqual(saved.dispatchReservations, ['wake-original']);
  const replacement = await invoke(store, 'wake-different');
  assert.equal(replacement.authorized, false);
  assert.equal(effects, 1, 'different wake must not execute second one-shot effect');

  // Reopen a genuinely separate PostgreSQL pool; this tests persistence,
  // rather than relying on advisory lock state in the original connection.
  const secondPool = new Pool({
    connectionString: pgUrl, max: 2, query_timeout: 5000,
    statement_timeout: 5000,
  });
  try {
    const reopened = new PostgresEventStore({
      pool: secondPool, tablePrefix: prefix, scopeId: 'scope-recovery',
    });
    await reopened.init();
    assert.equal((await invoke(reopened, 'wake-different')).authorized, false);
    // Recovery of the SAME wake retains its reserved right to attempt host
    // receipt reconciliation after OS death; host must dedup by wake ID.
    const resume = await reopened.withTriggerDispatchFence(
      'reserved-one-shot', '1', new Date().toISOString(),
      async () => {
        await reopened.setTriggerState(
          'reserved-one-shot', '1', 'completed',
          { type:'system', principal_id:'event-intelligence:lifecycle' },
          { fireCount:1, dispatchReservations:[] },
        );
        return 'reconciled-receipt';
      }, { wakeId:'wake-original' },
    );
    assert.equal(resume.authorized, true);
    assert.equal(resume.value, 'reconciled-receipt');
    const finalState = await reopened.getTriggerState('reserved-one-shot', '1');
    assert.equal(finalState.status, 'completed');
    assert.equal(finalState.fireCount, 1);
    assert.deepEqual(finalState.dispatchReservations, []);
    assert.equal((await invoke(reopened, 'wake-different')).authorized, false);
    assert.equal(effects, 1);
  } finally {
    await secondPool.end();
  }
}));

integration('busy delivery claims keep monotonic generations without consuming host-failure limit', async () => fixture(async ({ store }) => {
  const wakeId = 'busy-retry-test';
  const start = Date.parse('2026-10-18T12:00:00Z');
  const when = i => new Date(start + i * 1000).toISOString();
  await store.ensureWakeDelivery({
    wakeId, matchId:'busy-match', triggerId:'busy-trigger',
    triggerVersion:'1', runtime:'fixture-host', now:when(0),
  });
  for (let i = 0; i < 6; i++) {
    const claim = await store.claimWakeDelivery(wakeId, {
      workerId:'busy-owner', now:when(i * 2), leaseMs:30000,
    });
    assert.ok(claim, 'each idle-generation claim must be independently fenced');
    assert.equal(claim.attemptCount, i + 1);
    const deferred = await store.deferBusyWakeDelivery(wakeId, {
      workerId:'busy-owner', attemptCount:claim.attemptCount,
      now:when(i * 2), nextAttemptAt:when(i * 2 + 1),
    });
    assert.equal(deferred.status, 'retry_pending');
    assert.equal(deferred.dispatchContentions, i + 1);
    assert.equal(deferred.attemptCount, i + 1,
      'generation is never rolled backwards or reused');
  }
  const claim = await store.claimWakeDelivery(wakeId, {
    workerId:'busy-owner', now:when(13), leaseMs:30000,
  });
  assert.equal(claim.attemptCount, 7);
  const genuinelyFailed = await store.failWakeDelivery(wakeId, {
    workerId:'busy-owner', attemptCount:7,
    error:new Error('real host failure'), now:when(13),
    nextAttemptAt:when(14), maxAttempts:5,
  });
  assert.equal(genuinelyFailed.status, 'retry_pending',
    'six contention-only claims cannot spend all five real host attempts');
  assert.equal(genuinelyFailed.dispatchContentions, 6);
  assert.equal(genuinelyFailed.attemptCount, 7);
  const claimedAgain = await store.claimWakeDelivery(wakeId, {
    workerId:'new-owner', now:when(15), leaseMs:30000,
  });
  await assert.rejects(
    () => store.deferBusyWakeDelivery(wakeId, {
      workerId:'stale-owner', attemptCount:7,
      now:when(15), nextAttemptAt:when(16),
    }),
    error => error?.code === 'WAKE_DELIVERY_CLAIM_LOST',
    'monotonic attempt generation prevents stale wake release',
  );
  assert.equal(claimedAgain.attemptCount, 8);
}));
