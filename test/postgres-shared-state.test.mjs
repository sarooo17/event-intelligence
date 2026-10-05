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
  for (const suffix of ['leases', 'history', 'records', 'counters']) {
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
