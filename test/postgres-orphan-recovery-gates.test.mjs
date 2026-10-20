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
  const store = new PostgresEventStore({ pool, dispatchPoolIdentity:pool, tablePrefix: prefix, scopeId: 'scope-recovery' });
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
      pool: secondPool, dispatchPoolIdentity:secondPool, tablePrefix: prefix, scopeId: 'scope-recovery',
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


integration('bounded markFired rolls back lifecycle and match together when the second write fails', async () => fixture(async ({ store }) => {
  const engine = new CompositeTriggerEngine(store);
  await engine.register(trigger('atomic-mark-fired', { oneShot:true }));
  const consumed = await new CompositeEventConsumer({ store, triggerEngine:engine })
    .ingestMcpOccurrence({
      event:{ eventId:'atomic-event-1', name:'fixture.recovery.expiration',
        timestamp:new Date().toISOString(), data:{ slot:7 } },
      provider:'test-source', serverId:'test-source', traceId:'atomic-test',
    });
  const match = consumed.results.find(result => result.matched)?.match;
  assert.ok(match);
  const wakeId = 'atomic-wake-id';
  const originalUpsert = store.upsert.bind(store);
  let injected = false;
  store.upsert = async (...args) => {
    if (!injected && args[0] === 'trigger_match' && args[2]?.status === 'fired') {
      injected = true;
      throw new Error('injected-after-lifecycle-upsert');
    }
    return originalUpsert(...args);
  };
  try {
    await assert.rejects(() => store.withTriggerDispatchFence(
      'atomic-mark-fired', '1', new Date().toISOString(),
      () => engine.markFired(match.matchId, wakeId), { wakeId },
    ), /injected-after-lifecycle-upsert/);
  } finally {
    store.upsert = originalUpsert;
  }
  assert.equal(injected, true);
  const interrupted = await store.getTriggerState('atomic-mark-fired', '1');
  assert.equal(interrupted.fireCount, 0, 'transaction rollback must undo firing increment');
  assert.deepEqual(interrupted.dispatchReservations, [wakeId],
    'previously committed reservation remains durable after failed finalization');
  assert.equal((await store.listTriggerMatches('atomic-mark-fired'))
    .find(record => record.matchId === match.matchId)?.status, 'matched');

  const retry = await store.withTriggerDispatchFence(
    'atomic-mark-fired', '1', new Date().toISOString(),
    () => engine.markFired(match.matchId, wakeId), { wakeId },
  );
  assert.equal(retry.authorized, true);
  assert.equal(retry.value.status, 'fired');
  const finalized = await store.getTriggerState('atomic-mark-fired', '1');
  assert.equal(finalized.status, 'completed');
  assert.equal(finalized.fireCount, 1);
  assert.deepEqual(finalized.dispatchReservations, []);
  assert.equal(await store.verifyAudit(), true);
}));

integration('a callback queued behind pool admission cannot dispatch after its deadline', async () => fixture(async ({ store }) => {
  await store.putTrigger(trigger('occupies-slot'));
  await store.putTrigger(trigger('expires-in-queue', {
    expiresAt:new Date(Date.now() + 180).toISOString(),
  }));
  let enteredFirst, releaseFirst;
  const entered = new Promise(resolve => { enteredFirst = resolve; });
  const blocker = new Promise(resolve => { releaseFirst = resolve; });
  const first = store.withTriggerDispatchFence('occupies-slot', '1',
    new Date().toISOString(), async () => {
      enteredFirst();
      await blocker;
      return 'first-complete';
    });
  await entered;
  let forbiddenEffects = 0;
  const second = store.withTriggerDispatchFence('expires-in-queue', '1',
    new Date().toISOString(), async () => {
      forbiddenEffects++;
      return 'wrongly-authorized';
    });
  await new Promise(resolve => setTimeout(resolve, 260));
  releaseFirst();
  assert.equal((await first).authorized, true);
  const expired = await second;
  assert.equal(expired.authorized, false);
  assert.equal(expired.reason, 'trigger_not_active_at_dispatch');
  assert.equal(forbiddenEffects, 0);
}, { max:2 }));

integration('delivered receipt with still-matched one-shot is finalized by the real retry scheduler without host replay', async () => fixture(async ({ store }) => {
  const engine = new CompositeTriggerEngine(store);
  await engine.register(trigger('delivered-before-finalize', { oneShot:true }));
  const consumed = await new CompositeEventConsumer({ store, triggerEngine:engine })
    .ingestMcpOccurrence({
      event:{ eventId:'delivered-crash-1', name:'fixture.recovery.expiration',
        timestamp:new Date().toISOString(), data:{ slot:7 } },
      provider:'test-source', serverId:'test-source', traceId:'delivered-crash-test',
    });
  const match = consumed.results.find(result => result.matched)?.match;
  assert.ok(match);
  let hostCalls = 0;
  const coordinator = new CompositeWakeCoordinator({
    store, triggerEngine:engine, workerId:'recovery-one-shot',
    deliverer:async packet => {
      hostCalls++;
      return { runtimeReceiptId:'receipt:' + packet.wake_id };
    },
  });
  const originalMark = engine.markFired.bind(engine);
  engine.markFired = async () => {
    throw new Error('injected-crash-after-persisted-delivery-before-match');
  };
  try {
    const interrupted = await coordinator.deliverMatched(match);
    assert.equal(interrupted.status, 'claim_lost',
      'delivered claim cannot be turned back into an ordinary failed claim');
  } finally {
    engine.markFired = originalMark;
  }
  assert.equal(hostCalls, 1);
  assert.equal((await store.listTriggerMatches('delivered-before-finalize'))
    .find(record => record.matchId === match.matchId)?.status, 'matched');
  const due = await store.listDueWakeDeliveries();
  assert.equal(due.length, 1);
  assert.equal(due[0].status, 'delivered');
  const scheduler = new WakeRetryScheduler({
    store, resolveCoordinator:runtime => runtime === 'fixture-host' ? coordinator : null,
  });
  const repaired = await scheduler.runDue();
  assert.equal(repaired.find(row => row.matchId === match.matchId)?.status, 'wake_delivered');
  assert.equal(hostCalls, 1, 'durable receipt prevents replay of host callback');
  const state = await store.getTriggerState('delivered-before-finalize', '1');
  assert.equal(state.status, 'completed');
  assert.equal(state.fireCount, 1);
  assert.deepEqual(state.dispatchReservations, []);
  assert.equal((await store.listTriggerMatches('delivered-before-finalize'))
    .find(record => record.matchId === match.matchId)?.status, 'fired');
  assert.equal(await store.verifyAudit(), true);
}));


integration('coordinator uses only real host attempts for exponential retry delay after busy claims', async () => fixture(async ({ store }) => {
  const definition = trigger('host-backoff-after-contention');
  const engine = new CompositeTriggerEngine(store);
  await engine.register(definition);
  const consumed = await new CompositeEventConsumer({ store, triggerEngine:engine })
    .ingestMcpOccurrence({
      event:{ eventId:'backoff-event-1', name:'fixture.recovery.expiration',
        timestamp:new Date().toISOString(), data:{ slot:7 } },
      provider:'test-source', serverId:'test-source', traceId:'backoff-test',
    });
  const match = consumed.results.find(result => result.matched)?.match;
  assert.ok(match);
  const { sha256Hex } = await import('../dist/src/intelligenceProtocol/index.js');
  const identity = 'composite:' + match.matchId + ':' +
    definition.target.runtime + ':' + definition.target.id;
  const wakeId = 'wake_' + (await sha256Hex(identity)).slice(0, 24);
  const origin = Date.now() - 40000;
  const when = n => new Date(origin + n * 2000).toISOString();
  await store.ensureWakeDelivery({
    wakeId, matchId:match.matchId,
    triggerId:definition.triggerId, triggerVersion:definition.version,
    runtime:definition.target.runtime, now:when(0),
  });
  for (let i = 0; i < 6; i++) {
    const claim = await store.claimWakeDelivery(wakeId, {
      workerId:'busy-worker', now:when(i * 2),
    });
    assert.ok(claim);
    await store.deferBusyWakeDelivery(wakeId, {
      workerId:'busy-worker', attemptCount:claim.attemptCount,
      now:when(i * 2), nextAttemptAt:when(i * 2 + 1),
    });
  }
  let hostCalls = 0;
  const coordinator = new CompositeWakeCoordinator({
    store, triggerEngine:engine, workerId:'host-worker',
    now:() => new Date(when(13)),
    retryBaseDelayMs:1000, retryMaxDelayMs:60000, maxAttempts:5,
    deliverer:async () => { hostCalls++; throw new Error('simulated host failure'); },
  });
  const outcome = await coordinator.deliverMatched(match);
  assert.equal(outcome.status, 'retry_scheduled');
  assert.equal(hostCalls, 1);
  const persisted = await store.getWakeDelivery(wakeId);
  assert.equal(persisted.attemptCount, 7, 'claim ownership generation never goes backwards');
  assert.equal(persisted.dispatchContentions, 6);
  assert.equal(persisted.status, 'retry_pending');
  assert.equal(Date.parse(persisted.nextAttemptAt) - Date.parse(when(13)), 1000,
    'six no-host contentions cannot raise the first host failure to seventh backoff');
}));


integration('wrapped PostgreSQL pools fail closed without capacity and run safely with explicit two-slot limit', async () => fixture(async ({ store, pool, prefix }) => {
  await store.putTrigger(trigger('wrapped-pool-one'));
  await store.putTrigger(trigger('wrapped-pool-two'));
  // Satisfies the public PostgresPoolLike contract while deliberately hiding
  // node-postgres private options.max. Actual underlying pool max is TWO.
  const wrapper = {
    query:(...args) => pool.query(...args),
    connect:(...args) => pool.connect(...args),
  };
  const settings = { pool:wrapper, tablePrefix:prefix, scopeId:'scope-recovery' };
  const unconfigured = new PostgresEventStore(settings);
  let unsafeHostCalls = 0;
  await assert.rejects(() => unconfigured.withTriggerDispatchFence(
    'wrapped-pool-one', '1', new Date().toISOString(),
    async () => { unsafeHostCalls++; return 'unsafe'; },
  ), error => error?.code === 'EVENT_INTELLIGENCE_DISPATCH_POOL_SIZE_UNKNOWN');
  assert.equal(unsafeHostCalls, 0, 'unknown pool capacity cannot execute host effect');

  const sizeOnly = new PostgresEventStore({ ...settings, dispatchPoolMax:2 });
  await assert.rejects(() => sizeOnly.withTriggerDispatchFence(
    'wrapped-pool-one', '1', new Date().toISOString(),
    async () => { unsafeHostCalls++; return 'missing-identity'; },
  ), error => error?.code === 'EVENT_INTELLIGENCE_DISPATCH_POOL_IDENTITY_REQUIRED');
  assert.equal(unsafeHostCalls, 0);

  const configured = new PostgresEventStore({
    ...settings, dispatchPoolMax:2, dispatchPoolIdentity:pool,
  });
  const secondWrapper = {
    query:(...args) => pool.query(...args),
    connect:(...args) => pool.connect(...args),
  };
  const configuredSecond = new PostgresEventStore({
    ...settings, pool:secondWrapper, dispatchPoolMax:2,
    dispatchPoolIdentity:pool,
  });
  const scoped = await configured.forScope('other-scope');
  assert.equal(scoped.dispatchPoolMax, 2,
    'capacity configuration must survive scope-store construction');
  assert.equal(scoped.dispatchPoolIdentity, pool,
    'scoped store must retain exact physical admission identity');
  let firstEntered, releaseFirst;
  const entered = new Promise(resolve => { firstEntered = resolve; });
  const blocked = new Promise(resolve => { releaseFirst = resolve; });
  let active = 0, maxActive = 0;
  const run = (onStore, id, wait) => onStore.withTriggerDispatchFence(
    id, '1', new Date().toISOString(), async () => {
      active++;
      maxActive = Math.max(active, maxActive);
      if (wait) {
        firstEntered();
        await blocked;
      }
      assert.ok(await onStore.getTrigger(id, '1'),
        'fenced callback must retain a free PG connection');
      active--;
      return id;
    },
  );
  const a = run(configured, 'wrapped-pool-one', true);
  await entered;
  const b = run(configuredSecond, 'wrapped-pool-two', false);
  const c = run(store, 'wrapped-pool-two', false);
  releaseFirst();
  const responses = await Promise.all([a,b,c]);
  assert.deepEqual(responses.map(row => row.authorized), [true,true,true]);
  assert.equal(maxActive, 1,
    'two distinct wrappers AND the native pool must share one max=2 admission gate');

  const exaggerated = new PostgresEventStore({
    pool, tablePrefix:prefix, scopeId:'scope-recovery', dispatchPoolMax:3,
  });
  await assert.rejects(() => exaggerated.withTriggerDispatchFence(
    'wrapped-pool-one', '1', new Date().toISOString(),
    async () => 'unsafe-overconfiguration',
  ), error => error?.code === 'EVENT_INTELLIGENCE_DISPATCH_POOL_CAPACITY_MISMATCH');
}, { max:2 }));
