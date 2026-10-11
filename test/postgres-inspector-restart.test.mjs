import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { TriggerInspector } from '../scripts/lib/trigger-inspector.mjs';
import { TriggerControlPlane } from '../scripts/lib/trigger-control-plane.mjs';
import { createOwnerReadGuard } from '../scripts/lib/mcp-owner-read-guard.mjs';

const connectionString = process.env.POSTGRES_URL;
const integrationTest = connectionString ? test : test.skip;
const pg = connectionString ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const prefix = 'ei_inspect_' + randomBytes(6).toString('hex');
const triggerId = 'same-trigger-id';
const matchId = 'same-match-id';
const at = '2026-10-11T10:00:00.000Z';
const ownA = { type: 'user', principal_id: 'alice', tenant_id: 'tenant-a' };
const ownB = { type: 'user', principal_id: 'bob', tenant_id: 'tenant-b' };

function store(pool, scope) {
  return new PostgresEventStore({ pool, tablePrefix: prefix, scopeId: scope });
}

function trigger() {
  return {
    triggerId, version: '1',
    clauses: [
      { id: 'ready', event: 'account.ready', serverId: 'provider', arguments: {}, where: [] },
      { id: 'confirmed', event: 'account.confirmed', serverId: 'provider', arguments: {}, where: [] },
    ],
    pattern: {
      version: '2',
      root: {
        kind: 'allOf',
        children: [{ kind: 'event', ref: 'ready' }, { kind: 'event', ref: 'confirmed' }],
      },
    },
    withinMs: 60000,
    target: { runtime: 'test-host', kind: 'task', id: 'inspect-only' },
  };
}

function partial(scope, index) {
  const occurredAt = new Date(Date.parse(at) + index * 1000).toISOString();
  return {
    protocolVersion: '0.2.0', schemaVersion: 'trigger.v0.2',
    matchId, triggerId, triggerVersion: '1',
    status: 'partial', partitionKey: null,
    openedAt: at, expiresAt: '2026-10-11T10:01:00.000Z',
    updatedAt: occurredAt,
    sourceEvents: [{
      clauseId: 'ready', traceId: 'trace-' + scope,
      sourceEventId: 'source-' + scope, eventName: 'account.ready',
      serverId: 'provider', occurredAt: at,
      data: { privateToken: 'SECRET-' + scope },
    }],
    semanticDecision: null,
    patternState: {
      version: '2', role: 'buffer', signature: 'buffer-' + scope,
      semanticDecisions: [],
    },
    firedWakeId: null, derivedEventIds: [],
  };
}

async function cleanup(pool) {
  for (const name of ['metadata', 'leases', 'history', 'records', 'counters']) {
    await pool.query('DROP TABLE IF EXISTS "' + prefix + '_' + name + '" CASCADE');
  }
}

integrationTest('Postgres inspector is replay-stable, bounded and scope/owner isolated across pool restart', async () => {
  let poolA = new Pool({ connectionString, max: 4 });
  const poolB = new Pool({ connectionString, max: 4 });
  let poolAReopened = null;
  try {
    const a = store(poolA, 'tenant-a');
    const b = store(poolB, 'tenant-b');
    await a.init();
    await b.init();
    await a.putTrigger(trigger());
    await b.putTrigger(trigger());
    await a.setTriggerState(triggerId, '1', 'active', null, { owner: ownA });
    await b.setTriggerState(triggerId, '1', 'active', null, { owner: ownB });
    for (let i = 0; i < 7; i++) {
      await a.appendTriggerMatch(partial('tenant-a', i));
    }
    for (let i = 0; i < 4; i++) {
      await b.appendTriggerMatch(partial('tenant-b', i));
    }
    const readA = new TriggerInspector({ store: a, matchHistoryLimit: 3 });
    const readB = new TriggerInspector({ store: b, matchHistoryLimit: 2 });
    const aliceGuard = createOwnerReadGuard({
      store: a, triggerControl: new TriggerControlPlane({ store: a }),
      owner: ownA,
    });
    const foreignGuard = createOwnerReadGuard({
      store: a, triggerControl: new TriggerControlPlane({ store: a }),
      owner: ownB,
    });
    assert.equal((await aliceGuard.assertTrigger(triggerId, '1')).definition.triggerId, triggerId);
    await assert.rejects(
      () => foreignGuard.assertTrigger(triggerId, '1'),
      error => error?.code === 'EVENT_INTELLIGENCE_RESOURCE_NOT_FOUND',
    );
    const beforeA = await readA.inspect({ triggerId, version: '1', matchId });
    const beforeB = await readB.inspect({ triggerId, version: '1', matchId });
    assert.equal(beforeA.evidenceSummary.selectionBasis, 'explicit_match');
    assert.deepEqual(beforeA.evidenceSummary.observedClauseIds, ['ready']);
    assert.deepEqual(beforeA.evidenceSummary.unobservedClauseIds, ['confirmed']);
    assert.equal(beforeA.why.code, 'pattern_waiting');
    assert.equal(beforeA.lineage.matchHistory.length, 3);
    assert.equal(beforeA.lineage.historyTruncated, true);
    assert.equal(beforeB.lineage.matchHistory.length, 2);
    assert.equal(beforeB.lineage.historyTruncated, true);
    assert.equal(beforeA.lineage.evidence[0].sourceEventId, 'source-tenant-a');
    assert.equal(beforeB.lineage.evidence[0].sourceEventId, 'source-tenant-b');
    assert.equal(JSON.stringify(beforeA).includes('SECRET-'), false);
    assert.equal(JSON.stringify(beforeB).includes('SECRET-'), false);
    assert.equal(JSON.stringify(beforeA).includes('source-tenant-b'), false);

    // Close all connections used by the original tenant-A worker before
    // constructing a new PG pool and an entirely new inspector.
    await poolA.end();
    poolA = null;
    poolAReopened = new Pool({ connectionString, max: 4 });
    const aRestored = store(poolAReopened, 'tenant-a');
    await aRestored.init();
    const restoredGuard = createOwnerReadGuard({
      store: aRestored,
      triggerControl: new TriggerControlPlane({ store: aRestored }),
      owner: ownA,
    });
    await restoredGuard.assertTrigger(triggerId, '1');
    const afterA = await new TriggerInspector({
      store: aRestored, matchHistoryLimit: 3,
    }).inspect({ triggerId, version: '1', matchId });
    assert.deepEqual(afterA, beforeA,
      'causal explanation and bounded history must survive actual pool teardown');
    assert.deepEqual(
      await readB.inspect({ triggerId, version: '1', matchId }),
      beforeB,
      'same logical match ID in another tenant must stay independent',
    );
    await assert.rejects(
      () => createOwnerReadGuard({
        store: aRestored,
        triggerControl: new TriggerControlPlane({ store: aRestored }),
        owner: ownB,
      }).assertTrigger(triggerId, '1'),
      error => error?.code === 'EVENT_INTELLIGENCE_RESOURCE_NOT_FOUND',
    );
    assert.equal(JSON.stringify(afterA).includes('SECRET-tenant-a'), false);
  } finally {
    // Drop only the unique test-prefix tables; never alter external state.
    await cleanup(poolB);
    if (poolA) await poolA.end();
    if (poolAReopened) await poolAReopened.end();
    await poolB.end();
  }
});
