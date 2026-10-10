import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PostgresEventStore,
} from '../scripts/lib/postgres-event-store.mjs';
import {
  runStoreConformance,
} from '../scripts/lib/store-conformance.mjs';
import {
  createEventIntelligenceHost,
} from '../scripts/host-integration.mjs';
import {
  CompositeWakeCoordinator,
} from '../scripts/lib/composite-wake-coordinator.mjs';
import {
  CompositeTriggerEngine,
} from '../dist/src/composite/engine.js';
import {
  TriggerControlPlane,
} from '../scripts/lib/trigger-control-plane.mjs';

const POSTGRES_URL = process.env.POSTGRES_URL;
const integrationTest = POSTGRES_URL ? test : test.skip;
const pg = POSTGRES_URL ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const prefix = `ei_ha_${process.pid}_${Date.now()}`.slice(0, 40);

function pool() {
  return new Pool({ connectionString: POSTGRES_URL, max: 6 });
}

function store(dbPool, scopeId = 'default') {
  return new PostgresEventStore({
    pool: dbPool,
    scopeId,
    tablePrefix: prefix,
  });
}

function triggerDefinition(id = 'ha-trigger') {
  return {
    protocolVersion: '0.2.0',
    schemaVersion: 'trigger.v0.2',
    triggerId: id,
    version: '1',
    conditionOnly: false,
    clauses: [{
      id: 'event',
      event: 'ha.changed',
      arguments: {},
      where: [],
    }],
    pattern: {
      version: '2',
      root: { kind: 'event', ref: 'event' },
    },
    withinMs: 60000,
    lifecycle: {
      oneShot: false,
      cooldownMs: 0,
      completeOnGoal: false,
    },
    target: {
      runtime: 'ha-test',
      kind: 'task',
      id: 'task-1',
    },
    continuation: {
      instruction: 'Resume after the shared-state condition matches.',
      contextPolicy: {
        evidence: 'matched_events',
        maxEvents: 20,
        includeData: true,
      },
    },
  };
}

function matchedRecord(triggerId = 'ha-trigger', matchId = 'ha-match') {
  return {
    protocolVersion: '0.2.0',
    schemaVersion: 'trigger.v0.2',
    matchId,
    triggerId,
    triggerVersion: '1',
    status: 'matched',
    partitionKey: null,
    openedAt: '2026-10-05T10:00:00.000Z',
    expiresAt: '2026-10-05T10:01:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
    sourceEvents: [],
    semanticDecision: null,
    patternState: {
      version: '2',
      role: 'match',
      signature: matchId,
      semanticDecisions: [],
    },
    firedWakeId: null,
    derivedEventIds: [],
  };
}

async function dropTables(dbPool) {
  for (const suffix of ['metadata', 'leases', 'history', 'records', 'counters']) {
    await dbPool.query(`DROP TABLE IF EXISTS "${prefix}_${suffix}" CASCADE`);
  }
}

integrationTest('Postgres store passes shared conformance and shared-store host startup', async () => {
  const dbPool = pool();
  try {
    const report = await runStoreConformance({
      createStore: async () => store(dbPool),
      expectShared: true,
    });
    assert.equal(report.sharedReady, true);
    assert.equal(report.capabilities.sharedState, 'strong');
    assert.equal(report.capabilities.wakeClaims, 'distributed-atomic');
    assert.equal(report.capabilities.partitionLeases, 'distributed-atomic');

    const hostStore = store(dbPool, 'host-startup');
    const host = await createEventIntelligenceHost({
      store: hostStore,
      env: {
        EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE: 'true',
        EVENT_INTELLIGENCE_WORKER_ID: 'host-worker-a',
      },
    });
    assert.equal(host.storeCapabilities.sharedState, 'strong');
    await host.close();
  } finally {
    await dropTables(dbPool);
    await dbPool.end();
  }
});

integrationTest('two independent workers contend for exactly one wake delivery', async () => {
  const poolA = pool();
  const poolB = pool();
  let releaseDelivery;
  let enteredDelivery;
  const entered = new Promise((resolve) => { enteredDelivery = resolve; });
  const release = new Promise((resolve) => { releaseDelivery = resolve; });
  let deliveries = 0;

  try {
    const storeA = store(poolA, 'wake-contention');
    const storeB = store(poolB, 'wake-contention');
    await Promise.all([storeA.init(), storeB.init()]);
    await storeA.putTrigger(triggerDefinition());
    const match = await storeA.appendTriggerMatch(matchedRecord());

    const engineA = new CompositeTriggerEngine(storeA);
    const engineB = new CompositeTriggerEngine(storeB);
    const deliverer = async () => {
      deliveries += 1;
      enteredDelivery();
      await release;
      return { runtimeReceiptId: 'shared-receipt-1' };
    };
    const first = new CompositeWakeCoordinator({
      store: storeA,
      triggerEngine: engineA,
      workerId: 'worker-a',
      deliverer,
    });
    const second = new CompositeWakeCoordinator({
      store: storeB,
      triggerEngine: engineB,
      workerId: 'worker-b',
      deliverer,
    });

    const firstRun = first.deliverMatched(match);
    await entered;
    const current = (await storeB.listTriggerMatches('ha-trigger'))
      .find((candidate) => candidate.matchId === 'ha-match');
    const secondRun = await second.deliverMatched(current);
    assert.equal(secondRun.status, 'delivery_in_progress');
    assert.equal(deliveries, 1);

    releaseDelivery();
    const completed = await firstRun;
    assert.equal(completed.status, 'wake_delivered');
    assert.equal(deliveries, 1);
    const finalMatch = (await storeB.listTriggerMatches('ha-trigger'))
      .find((candidate) => candidate.matchId === 'ha-match');
    assert.equal(finalMatch.status, 'fired');
  } finally {
    releaseDelivery?.();
    await dropTables(poolA);
    await Promise.all([poolA.end(), poolB.end()]);
  }
});

integrationTest('expired wake and partition leases recover on another worker and DLQ stays shared', async () => {
  const poolA = pool();
  const poolB = pool();
  const t0 = new Date('2026-10-05T11:00:00.000Z');
  try {
    const storeA = store(poolA, 'lease-recovery');
    const storeB = store(poolB, 'lease-recovery');
    await Promise.all([storeA.init(), storeB.init()]);

    await storeA.ensureWakeDelivery({
      wakeId: 'recover-wake',
      matchId: 'recover-match',
      triggerId: 'recover-trigger',
      triggerVersion: '1',
      runtime: 'ha-test',
      now: t0.toISOString(),
    });
    const claimA = await storeA.claimWakeDelivery('recover-wake', {
      workerId: 'worker-a',
      now: t0.toISOString(),
      leaseMs: 1000,
    });
    assert.ok(claimA);
    assert.equal(await storeB.claimWakeDelivery('recover-wake', {
      workerId: 'worker-b',
      now: new Date(t0.getTime() + 500).toISOString(),
      leaseMs: 1000,
    }), null);

    const claimB = await storeB.claimWakeDelivery('recover-wake', {
      workerId: 'worker-b',
      now: new Date(t0.getTime() + 1100).toISOString(),
      leaseMs: 1000,
    });
    assert.ok(claimB);
    assert.equal(claimB.attemptCount, 2);
    await assert.rejects(
      () => storeA.completeWakeDelivery('recover-wake', {
        workerId: 'worker-a',
        runtimeReceiptId: 'stale-owner',
        now: new Date(t0.getTime() + 1200).toISOString(),
      }),
      (error) => error?.code === 'WAKE_DELIVERY_CLAIM_LOST',
    );

    const failed = await storeB.failWakeDelivery('recover-wake', {
      workerId: 'worker-b',
      error: new Error('retry me'),
      now: new Date(t0.getTime() + 1200).toISOString(),
      nextAttemptAt: new Date(t0.getTime() + 2200).toISOString(),
      maxAttempts: 3,
    });
    assert.equal(failed.status, 'retry_pending');

    const claimA2 = await storeA.claimWakeDelivery('recover-wake', {
      workerId: 'worker-a',
      now: new Date(t0.getTime() + 2300).toISOString(),
      leaseMs: 1000,
    });
    assert.ok(claimA2);
    assert.equal(claimA2.attemptCount, 3);
    const dead = await storeA.failWakeDelivery('recover-wake', {
      workerId: 'worker-a',
      error: new Error('permanent'),
      now: new Date(t0.getTime() + 2400).toISOString(),
      maxAttempts: 3,
    });
    assert.equal(dead.status, 'dead_letter');
    assert.equal((await storeB.getWakeDelivery('recover-wake')).status, 'dead_letter');

    const [leaseA, leaseB] = await Promise.all([
      storeA.claimPartitionLease('trigger:1:customer-7', {
        workerId: 'worker-a',
        now: t0.toISOString(),
        leaseMs: 1000,
      }),
      storeB.claimPartitionLease('trigger:1:customer-7', {
        workerId: 'worker-b',
        now: t0.toISOString(),
        leaseMs: 1000,
      }),
    ]);
    assert.equal([leaseA, leaseB].filter(Boolean).length, 1);
    const expiredOwner = leaseA ? 'worker-a' : 'worker-b';
    const recoveringStore = expiredOwner === 'worker-a' ? storeB : storeA;
    const recovered = await recoveringStore.claimPartitionLease(
      'trigger:1:customer-7',
      {
        workerId: expiredOwner === 'worker-a' ? 'worker-b' : 'worker-a',
        now: new Date(t0.getTime() + 1100).toISOString(),
        leaseMs: 1000,
      },
    );
    assert.ok(recovered);
  } finally {
    await dropTables(poolA);
    await Promise.all([poolA.end(), poolB.end()]);
  }
});

integrationTest('concurrent match finalization advances lifecycle exactly once', async () => {
  const poolA = pool();
  const poolB = pool();
  try {
    const storeA = store(poolA, 'match-cas');
    const storeB = store(poolB, 'match-cas');
    await Promise.all([storeA.init(), storeB.init()]);
    await storeA.putTrigger(triggerDefinition('cas-trigger'));
    await storeA.setTriggerState(
      'cas-trigger',
      '1',
      'active',
      { type: 'system', principal_id: 'setup' },
      { fireCount: 0 },
    );
    await storeA.appendTriggerMatch(
      matchedRecord('cas-trigger', 'cas-match'),
    );

    const engineA = new CompositeTriggerEngine(storeA);
    const engineB = new CompositeTriggerEngine(storeB);
    const [a, b] = await Promise.all([
      engineA.markFired('cas-match', 'cas-wake'),
      engineB.markFired('cas-match', 'cas-wake'),
    ]);
    assert.equal(a.status, 'fired');
    assert.equal(b.status, 'fired');

    const state = await storeB.getTriggerState('cas-trigger', '1');
    assert.equal(state.fireCount, 1);
    const history = await storeA.listTriggerMatchHistory('cas-match');
    assert.equal(
      history.filter((record) => record.status === 'fired').length,
      1,
    );
  } finally {
    await dropTables(poolA);
    await Promise.all([poolA.end(), poolB.end()]);
  }
});

integrationTest('control-plane mutations are serialized by trigger/version lease', async () => {
  const poolA = pool();
  const poolB = pool();
  let releaseMutation;
  let enteredMutation;
  const entered = new Promise((resolve) => { enteredMutation = resolve; });
  const release = new Promise((resolve) => { releaseMutation = resolve; });
  const owner = { type: 'owner', principal_id: 'owner-1' };
  const actor = { type: 'system', principal_id: 'operator' };

  try {
    const storeA = store(poolA, 'control-lease');
    const storeB = store(poolB, 'control-lease');
    await Promise.all([storeA.init(), storeB.init()]);
    await storeA.putTrigger(triggerDefinition('control-trigger'));
    await storeA.setTriggerState(
      'control-trigger',
      '1',
      'active',
      actor,
      { owner, connectionIds: [] },
    );

    const originalSet = storeA.setTriggerState.bind(storeA);
    storeA.setTriggerState = async (...args) => {
      enteredMutation();
      await release;
      return originalSet(...args);
    };

    const controlA = new TriggerControlPlane({
      store: storeA,
      triggerEngine: {},
      workerId: 'control-worker-a',
      mutationLeaseMs: 30000,
    });
    const controlB = new TriggerControlPlane({
      store: storeB,
      triggerEngine: {},
      workerId: 'control-worker-b',
      mutationLeaseMs: 30000,
    });

    const first = controlA.pauseTrigger({
      triggerId: 'control-trigger',
      version: '1',
      actor,
      owner,
    });
    await entered;

    await assert.rejects(
      () => controlB.pauseTrigger({
        triggerId: 'control-trigger',
        version: '1',
        actor,
        owner,
      }),
      (error) => error?.code === 'TRIGGER_MUTATION_BUSY',
    );

    releaseMutation();
    const paused = await first;
    assert.equal(paused.state.status, 'paused');
    assert.equal(
      (await storeB.getTriggerState('control-trigger', '1')).status,
      'paused',
    );
  } finally {
    releaseMutation?.();
    await dropTables(poolA);
    await Promise.all([poolA.end(), poolB.end()]);
  }
});

integrationTest('scope isolation and audit ordering remain authoritative across workers', async () => {
  const poolA = pool();
  const poolB = pool();
  try {
    const rootA = store(poolA);
    const rootB = store(poolB);
    await Promise.all([rootA.init(), rootB.init()]);
    const tenantA = await rootA.forScope('tenant-a');
    const tenantB = await rootB.forScope('tenant-b');

    await Promise.all([
      tenantA.putTrigger(triggerDefinition('same-trigger')),
      tenantB.putTrigger(triggerDefinition('same-trigger')),
    ]);
    assert.equal((await tenantA.listTriggers()).length, 1);
    assert.equal((await tenantB.listTriggers()).length, 1);

    const sameScopeA = await rootA.forScope('audit-shared');
    const sameScopeB = await rootB.forScope('audit-shared');
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? sameScopeA : sameScopeB).appendAudit({
          auditId: `audit-${index}`,
          traceId: 'shared-trace',
          timestamp: new Date(Date.UTC(2026, 9, 5, 12, 0, 0, index)).toISOString(),
          kind: 'trigger.created',
          entityType: 'trigger',
          entityId: `trigger-${index}`,
          details: { index },
        })
      ),
    );
    const audit = await sameScopeA.listAudit();
    assert.equal(audit.length, 20);
    assert.deepEqual(
      audit.map((record) => record.sequence),
      Array.from({ length: 20 }, (_, i) => i),
    );
    assert.equal(await sameScopeB.verifyAudit(), true);

    const scopes = await rootA.listScopeIds();
    assert.ok(scopes.includes('tenant-a'));
    assert.ok(scopes.includes('tenant-b'));
    assert.ok(scopes.includes('audit-shared'));
  } finally {
    await dropTables(poolA);
    await Promise.all([poolA.end(), poolB.end()]);
  }
});


integrationTest('Postgres history window uses stable order and isolates tenant scopes', async () => {
  const dbPool = pool();
  try {
    const a = store(dbPool, 'history-tenant-a');
    const b = store(dbPool, 'history-tenant-b');
    await Promise.all([a.init(), b.init()]);
    const matchId = 'history-one';
    for (let i = 0; i < 6; i += 1) {
      await a.appendTriggerMatch({
        ...matchedRecord('ha-history', matchId),
        updatedAt: new Date(Date.UTC(2026, 9, 5, 10, 0, i)).toISOString(),
      });
    }
    const recent = await a.getRecentTriggerMatchHistory(matchId, { limit: 2 });
    assert.equal(recent.limit, 2);
    assert.equal(recent.hasMore, true);
    assert.deepEqual(recent.records.map((entry) => entry.updatedAt), [
      '2026-10-05T10:00:04.000Z',
      '2026-10-05T10:00:05.000Z',
    ]);
    const all = await a.getRecentTriggerMatchHistory(matchId, { limit: 6 });
    assert.equal(all.records.length, 6);
    assert.equal(all.hasMore, false);
    const foreign = await b.getRecentTriggerMatchHistory(matchId, { limit: 2 });
    assert.deepEqual(foreign.records, []);
    assert.equal(foreign.hasMore, false);
    await assert.rejects(
      () => a.getRecentTriggerMatchHistory(matchId, { limit: 0 }),
      (error) => error.code === 'EVENT_INTELLIGENCE_HISTORY_LIMIT_INVALID',
    );
  } finally {
    await dropTables(dbPool);
    await dbPool.end();
  }
});

integrationTest('fresh schema receives durable version marker and survives independent restart', async () => {
  const dbPool = pool();
  try {
    const first = store(dbPool, 'schema-first');
    await first.init();
    const row = await dbPool.query(
      'SELECT version, adopted_from FROM "' + prefix + '_metadata" WHERE component = $1',
      ['store'],
    );
    assert.equal(Number(row.rows[0].version), 1);
    assert.equal(row.rows[0].adopted_from, null);
    await first.putTrigger(triggerDefinition('schema-marker-trigger'));
    const second = store(dbPool, 'schema-second');
    await second.init();
    assert.equal((await second.forScope('schema-first')).initialized, true);
    assert.equal((await first.listTriggers()).length, 1);
  } finally {
    await dropTables(dbPool);
    await dbPool.end();
  }
});

integrationTest('unknown newer PostgreSQL schema refuses startup without data mutation', async () => {
  const dbPool = pool();
  try {
    const first = store(dbPool);
    await first.init();
    await first.putTrigger(triggerDefinition('preserved-trigger'));
    await dbPool.query(
      'UPDATE "' + prefix + '_metadata" SET version = $1 WHERE component = $2',
      [99, 'store'],
    );
    await assert.rejects(
      () => store(dbPool).init(),
      (error) => error.code === 'EVENT_INTELLIGENCE_POSTGRES_SCHEMA_INCOMPATIBLE',
    );
    // Database content remains untouched; an operator can restore the marker.
    await dbPool.query(
      'UPDATE "' + prefix + '_metadata" SET version = $1 WHERE component = $2',
      [1, 'store'],
    );
    const restored = store(dbPool);
    await restored.init();
    assert.equal((await restored.listTriggers())[0].triggerId, 'preserved-trigger');
  } finally {
    await dropTables(dbPool);
    await dbPool.end();
  }
});

integrationTest('nonempty unversioned store demands explicit operator adoption', async () => {
  const dbPool = pool();
  try {
    const first = store(dbPool);
    await first.init();
    await first.putTrigger(triggerDefinition('legacy-kept'));
    await dbPool.query(
      'DELETE FROM "' + prefix + '_metadata" WHERE component = $1',
      ['store'],
    );
    await assert.rejects(
      () => store(dbPool).init(),
      (error) => error.code === 'EVENT_INTELLIGENCE_POSTGRES_SCHEMA_UNVERSIONED',
    );
    const count = await dbPool.query(
      'SELECT count(*)::int AS n FROM "' + prefix +
      '_records" WHERE kind = $1',
      ['trigger'],
    );
    assert.equal(Number(count.rows[0].n), 1);
    const adopted = new PostgresEventStore({
      pool: dbPool,
      tablePrefix: prefix,
      adoptUnversionedSchema: true,
    });
    await adopted.init();
    const metadata = await dbPool.query(
      'SELECT version, adopted_from FROM "' + prefix + '_metadata" WHERE component = $1',
      ['store'],
    );
    assert.equal(Number(metadata.rows[0].version), 1);
    assert.equal(metadata.rows[0].adopted_from, 'unversioned-explicit');
    assert.equal((await adopted.listTriggers())[0].triggerId, 'legacy-kept');
    await store(dbPool).init(); // independent worker accepts adopted v1 marker
  } finally {
    await dropTables(dbPool);
    await dbPool.end();
  }
});

integrationTest('empty malformed legacy table cannot receive a trusted schema marker', async () => {
  const dbPool = pool();
  try {
    // A colliding relation with only indexed columns must never be treated
    // as a fresh v1 store just because it contains no rows.
    await dbPool.query(
      'CREATE TABLE "' + prefix + '_records" (scope_id TEXT, kind TEXT)',
    );
    await assert.rejects(
      () => store(dbPool).init(),
      (error) => error.code === 'EVENT_INTELLIGENCE_POSTGRES_SCHEMA_SHAPE_INVALID',
    );
    const marker = await dbPool.query(
      'SELECT to_regclass($1) AS relation',
      [prefix + '_metadata'],
    );
    assert.equal(marker.rows[0].relation, null);
    await dbPool.query('DROP TABLE "' + prefix + '_records"');
    const valid = store(dbPool);
    await valid.init();
    const version = await dbPool.query(
      'SELECT version FROM "' + prefix + '_metadata" WHERE component = $1',
      ['store'],
    );
    assert.equal(Number(version.rows[0].version), 1);
  } finally {
    await dropTables(dbPool);
    await dbPool.end();
  }
});


integrationTest('bounded adversarial wake claims: four workers, 20 independent lease handovers', async () => {
  const poolA = pool();
  const poolB = pool();
  const base = Date.parse('2026-10-06T00:00:00.000Z');
  try {
    const workers = [
      store(poolA, 'chaos-wake'),
      store(poolB, 'chaos-wake'),
      store(poolA, 'chaos-wake'),
      store(poolB, 'chaos-wake'),
    ];
    await Promise.all(workers.map((worker) => worker.init()));

    for (let round = 0; round < 20; round += 1) {
      const wakeId = 'chaos-wake-' + round;
      const now = base + round * 100000;
      await workers[0].ensureWakeDelivery({
        wakeId,
        matchId: 'chaos-match-' + round,
        triggerId: 'chaos-trigger',
        triggerVersion: '1',
        runtime: 'ha-chaos',
        now: new Date(now).toISOString(),
      });
      const claimed = await Promise.all(workers.map((worker, index) =>
        worker.claimWakeDelivery(wakeId, {
          workerId: 'worker-' + index,
          now: new Date(now).toISOString(),
          leaseMs: 1000,
        }),
      ));
      const winners = claimed.flatMap((row, index) =>
        row ? [index] : []
      );
      assert.equal(winners.length, 1, 'round=' + round);

      const winner = winners[0];
      // Alternate between a different worker and the SAME worker reclaiming
      // its expired generation (the ABA case). Old attempts must be fenced.
      const successor = round % 2 === 0
        ? winner
        : (winner + 1) % workers.length;
      assert.equal(
        await workers[successor].claimWakeDelivery(wakeId, {
          workerId: 'worker-' + successor,
          now: new Date(now + 999).toISOString(),
          leaseMs: 1000,
        }),
        null,
        'lease must not expire a millisecond early',
      );

      const takeover = await workers[successor].claimWakeDelivery(wakeId, {
        workerId: 'worker-' + successor,
        now: new Date(now + 1000).toISOString(),
        leaseMs: 1000,
      });
      assert.ok(takeover, 'round=' + round + ' takeover missing');
      assert.equal(takeover.attemptCount, 2);

      await assert.rejects(
        () => workers[winner].completeWakeDelivery(wakeId, {
          workerId: 'worker-' + winner,
          attemptCount: claimed[winner].attemptCount,
          runtimeReceiptId: 'obsolete-' + round,
          now: new Date(now + 1100).toISOString(),
        }),
        (error) => error.code === 'WAKE_DELIVERY_CLAIM_LOST',
      );

      const accepted = await workers[successor].completeWakeDelivery(wakeId, {
        workerId: 'worker-' + successor,
        attemptCount: takeover.attemptCount,
        runtimeReceiptId: 'receipt-' + round,
        now: new Date(now + 1200).toISOString(),
      });
      assert.equal(accepted.status, 'delivered');
      const after = await workers[(successor + 1) % workers.length]
        .getWakeDelivery(wakeId);
      assert.equal(after.runtimeReceiptId, 'receipt-' + round);
      assert.equal(await workers[winner].claimWakeDelivery(wakeId, {
        workerId: 'worker-' + winner,
        now: new Date(now + 2000).toISOString(),
        leaseMs: 1000,
      }), null);
    }
  } finally {
    await dropTables(poolA);
    await Promise.all([poolA.end(), poolB.end()]);
  }
});

integrationTest('identical wake IDs can be claimed independently by two isolated scopes', async () => {
  const dbPool = pool();
  try {
    const scopeA = store(dbPool, 'tenant-A');
    const scopeB = store(dbPool, 'tenant-B');
    await Promise.all([scopeA.init(), scopeB.init()]);
    const input = {
      wakeId: 'shared-wake-id',
      matchId: 'shared-match-id',
      triggerId: 'shared-trigger-id',
      triggerVersion: '1',
      runtime: 'scope-test',
      now: '2026-10-06T01:00:00.000Z',
    };
    await Promise.all([
      scopeA.ensureWakeDelivery(input),
      scopeB.ensureWakeDelivery(input),
    ]);
    const [a, b] = await Promise.all([
      scopeA.claimWakeDelivery('shared-wake-id', {
        workerId: 'scope-a-owner', now: input.now, leaseMs: 1000,
      }),
      scopeB.claimWakeDelivery('shared-wake-id', {
        workerId: 'scope-b-owner', now: input.now, leaseMs: 1000,
      }),
    ]);
    assert.ok(a);
    assert.ok(b);
    await scopeA.completeWakeDelivery('shared-wake-id', {
      workerId: 'scope-a-owner',
      runtimeReceiptId: 'receipt-A',
      now: '2026-10-06T01:00:00.100Z',
    });
    const stillB = await scopeB.getWakeDelivery('shared-wake-id');
    assert.equal(stillB.status, 'claimed');
    assert.equal(stillB.runtimeReceiptId, null);
    await scopeB.completeWakeDelivery('shared-wake-id', {
      workerId: 'scope-b-owner',
      runtimeReceiptId: 'receipt-B',
      now: '2026-10-06T01:00:00.100Z',
    });
    assert.equal((await scopeA.getWakeDelivery('shared-wake-id')).runtimeReceiptId, 'receipt-A');
    assert.equal((await scopeB.getWakeDelivery('shared-wake-id')).runtimeReceiptId, 'receipt-B');
  } finally {
    await dropTables(dbPool);
    await dbPool.end();
  }
});
