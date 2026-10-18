import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';
import { sha256Hex, WakeRecordSchema } from '../dist/src/intelligenceProtocol/index.js';

const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integration = url ? test : test.skip;
const at = '2026-10-18T14:00:00.000Z';

function definition(slot) {
  return {
    triggerId: 'receipt-before-finalize-' + slot,
    version: '1',
    clauses: [{
      id: 'changed', event: 'fixture.delivery.confirmed',
      arguments: {},
      where: [{ path: 'slot', op: 'eq', value: slot }],
    }],
    pattern: { version: '2', root: { kind: 'event', ref: 'changed' } },
    withinMs: 60000,
    lifecycle: { oneShot: false, cooldownMs: 0, completeOnGoal: false },
    target: { runtime: 'fixture-host', kind: 'task', id: 'turn-' + slot },
  };
}
function occurrence(slot) {
  return {
    traceId: 'receipt-trace-' + slot,
    sourceEventId: 'receipt-source-' + slot,
    name: 'fixture.delivery.confirmed',
    occurredAt: at,
    serverId: 'fixture-provider',
    data: { slot },
  };
}

integration('PostgreSQL recovery finalizes delivered EI receipt before wake append or match-fired without host redispatch', async () => {
  const prefix = 'ei_receipt_gap_' + randomBytes(5).toString('hex');
  const scopeId = 'receipt-gap-tenant';
  let originalPool = new Pool({ connectionString: url, max: 3 });
  let recoveredPool = null;
  let hostInvocations = 0;
  const cases = [];
  try {
    const first = new PostgresEventStore({
      pool: originalPool, tablePrefix: prefix, scopeId,
    });
    await first.init();
    const engine = new CompositeTriggerEngine(first);
    for (const slot of [0, 1]) {
      const def = definition(slot);
      await engine.register(def);
      const rows = await engine.ingest(occurrence(slot));
      const matched = rows.filter(row =>
        row.matched && row.match?.status === 'matched' &&
        row.triggerId === def.triggerId);
      assert.equal(matched.length, 1);
      const match = matched[0].match;
      const wakeId = 'wake_' + (await sha256Hex(
        'composite:' + match.matchId + ':' +
        def.target.runtime + ':' + def.target.id,
      )).slice(0, 24);
      const receiptId = 'host-durable-receipt-' + slot;
      await first.ensureWakeDelivery({
        wakeId, matchId: match.matchId,
        triggerId: def.triggerId, triggerVersion: def.version,
        runtime: def.target.runtime, now: at,
      });
      const claimed = await first.claimWakeDelivery(wakeId, {
        workerId: 'crashed-before-finalize', now: at, leaseMs: 1000,
      });
      assert.equal(claimed?.attemptCount, 1);
      const persisted = await first.completeWakeDelivery(wakeId, {
        workerId: 'crashed-before-finalize',
        attemptCount: claimed.attemptCount,
        runtimeReceiptId: receiptId, now: at,
      });
      assert.equal(persisted?.status, 'delivered');
      // Two distinct boundaries:
      // 0: EI delivery receipt committed, WakeRecord not yet appended.
      // 1: EI delivery receipt + WakeRecord committed, match not fired.
      if (slot === 1) {
        await first.appendWake(WakeRecordSchema.parse({
          wakeId, traceId: match.matchId,
          decisionId: null, subscriptionId: 'trigger:' + def.triggerId,
          sourceEventId: match.matchId,
          createdAt: at, target: def.target,
          status: 'delivered', runtimeReceiptId: receiptId,
        }));
      }
      assert.equal((await first.listTriggerMatches(def.triggerId))
        .find(row => row.matchId === match.matchId).status, 'matched');
      assert.equal((await first.getWakeDelivery(wakeId)).runtimeReceiptId,
        receiptId);
      cases.push({ slot, def, matchId: match.matchId, wakeId, receiptId });
    }

    // Simulate loss of the entire original worker connection pool. A
    // fresh worker must inspect the authoritative delivery receipt and
    // reconstruct ONLY the missing EI state, not call the external host.
    await originalPool.end();
    originalPool = null;
    recoveredPool = new Pool({ connectionString: url, max: 3 });
    const recovered = new PostgresEventStore({
      pool: recoveredPool, tablePrefix: prefix, scopeId,
    });
    await recovered.init();
    const recoveredEngine = new CompositeTriggerEngine(recovered);
    const coordinator = new CompositeWakeCoordinator({
      store: recovered, triggerEngine: recoveredEngine,
      workerId: 'fresh-worker-after-receipt',
      now: () => new Date(at),
      deliverer: async () => {
        hostInvocations += 1;
        throw new Error('host must never be called after durable receipt');
      },
    });
    for (const { slot, def, matchId, wakeId, receiptId } of cases) {
      const savedMatch = (await recovered.listTriggerMatches(def.triggerId))
        .find(row => row.matchId === matchId);
      assert.equal(savedMatch.status, 'matched');
      const due = await recovered.listDueWakeDeliveries(at);
      assert.ok(due.some(row => row.wakeId === wakeId),
        'receipt/finalization inconsistency must be discoverable');
      const resumed = await coordinator.deliverMatched(savedMatch);
      assert.equal(resumed.status, 'wake_delivered');
      assert.equal(resumed.wake.wakeId, wakeId);
      assert.equal(resumed.wake.runtimeReceiptId, receiptId);
      assert.equal((await recovered.getWakeDelivery(wakeId)).attemptCount, 1,
        'recovery must not claim an already delivered wake');
      const nowFired = (await recovered.listTriggerMatches(def.triggerId))
        .find(row => row.matchId === matchId);
      assert.equal(nowFired.status, 'fired');
      assert.equal(nowFired.firedWakeId, wakeId);
      const recheck = await coordinator.deliverMatched(nowFired);
      assert.equal(recheck.status, 'already_fired');
      assert.equal(recheck.wake.wakeId, wakeId);

      const audit = await recoveredPool.query(
        'SELECT COUNT(*)::int AS count FROM "' + prefix + '_history"' +
          " WHERE scope_id=$1 AND kind='wake' AND record_key=$2",
        [scopeId, wakeId],
      );
      assert.equal(audit.rows[0].count, 1,
        'wake finalization must append at most one delivered WakeRecord');
      assert.equal(hostInvocations, 0);
    }
    assert.equal(await recovered.verifyAudit(), true);
  } finally {
    const cleanup = recoveredPool ?? originalPool ??
      new Pool({ connectionString: url, max: 2 });
    try {
      for (const kind of ['metadata','leases','history','records','counters']) {
        await cleanup.query(
          'DROP TABLE IF EXISTS "' + prefix + '_' + kind + '" CASCADE',
        );
      }
    } finally {
      for (const p of new Set([originalPool, recoveredPool, cleanup].filter(Boolean))) {
        await p.end();
      }
    }
  }
});
