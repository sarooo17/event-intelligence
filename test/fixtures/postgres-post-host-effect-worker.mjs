// Disposable PG16 test-only host: independent Node process & physical pools.
// Simulates a host with durable idempotency keyed by EI's stable wake_id.
import { Pool } from 'pg';
import { PostgresEventStore } from '../../scripts/lib/postgres-event-store.mjs';
import { CompositeTriggerEngine } from '../../dist/src/composite/engine.js';
import { CompositeWakeCoordinator } from '../../scripts/lib/composite-wake-coordinator.mjs';

const { POSTGRES_URL: url, EI_EFFECT_PREFIX: tablePrefix,
  EI_EFFECT_SCOPE: scopeId, EI_EFFECT_TRIGGER: triggerId,
  EI_EFFECT_MATCH: matchId, EI_EFFECT_NOW: now,
  EI_EFFECT_WORKER: workerId, EI_EFFECT_MODE: mode } = process.env;
const effects = '"' + tablePrefix + '_host_effects"';
const attempts = '"' + tablePrefix + '_host_attempts"';
let storePool, hostPool;
let stage = 'configuration';
try {
  if (!url || !tablePrefix || !scopeId || !triggerId || !matchId ||
      !workerId || !now || !['post-effect-hold', 'reconcile'].includes(mode)) {
    throw Object.assign(new Error('missing test fixture configuration'), {
      code: 'EI_EFFECT_WORKER_CONFIG_INVALID',
    });
  }
  storePool = new Pool({
    connectionString: url, max: 2, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: 5000,
  });
  hostPool = new Pool({
    connectionString: url, max: 2, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: 5000,
  });
  const store = new PostgresEventStore({ pool: storePool, tablePrefix, scopeId });
  stage = 'init';
  await store.init();
  const match = (await store.listTriggerMatches(triggerId))
    .find(row => row.matchId === matchId);
  if (match?.status !== 'matched') {
    throw Object.assign(new Error('durable matched state missing'), {
      code: 'EI_EFFECT_MATCH_NOT_FOUND',
    });
  }
  stage = 'delivery';
  const coordinator = new CompositeWakeCoordinator({
    store, triggerEngine: new CompositeTriggerEngine(store),
    workerId, leaseMs: 1000,
    now: () => new Date(now),
    deliverer: async packet => {
      if (packet.trigger_match_id !== matchId || !packet.wake_id) {
        throw Object.assign(new Error('unexpected host wake identity'), {
          code: 'EI_EFFECT_PACKET_INVALID',
        });
      }
      // Durable *host-controlled* attempt log and once-only effect are
      // separate from EI claim/receipt writes. It is an idempotent host
      // fixture, not a claim that EI owns external side effects.
      await hostPool.query(
        'INSERT INTO ' + attempts +
          ' (wake_id, worker_id) VALUES ($1, $2)',
        [packet.wake_id, workerId],
      );
      const receiptId = 'host-receipt:' + packet.wake_id;
      const inserted = await hostPool.query(
        'INSERT INTO ' + effects +
          ' (wake_id, receipt_id) VALUES ($1, $2)' +
          ' ON CONFLICT (wake_id) DO NOTHING RETURNING receipt_id',
        [packet.wake_id, receiptId],
      );
      const read = await hostPool.query(
        'SELECT receipt_id FROM ' + effects + ' WHERE wake_id=$1',
        [packet.wake_id],
      );
      if (read.rows[0]?.receipt_id !== receiptId) {
        throw Object.assign(new Error('host idempotency lookup failed'), {
          code: 'EI_EFFECT_HOST_RECEIPT_INVALID',
        });
      }
      if (mode === 'post-effect-hold') {
        if (inserted.rowCount !== 1) {
          throw Object.assign(new Error('victim host effect was duplicate'), {
            code: 'EI_EFFECT_UNEXPECTED_DUPLICATE',
          });
        }
        // This ACK happens only AFTER the independent host table commits.
        // Pause before returning the receipt to EI; the parent SIGKILLs
        // this real OS process. No EI completeWakeDelivery() can happen.
        process.send?.({
          type: 'host-effect-committed', pid: process.pid,
          wakeId: packet.wake_id, matchId,
          receiptId, workerId,
        });
        setInterval(() => {}, 60_000);
        return new Promise(() => {});
      }
      if (inserted.rowCount !== 0) {
        throw Object.assign(new Error('successor created a second host effect'), {
          code: 'EI_EFFECT_RECONCILIATION_DUPLICATED',
        });
      }
      return { runtimeReceiptId: receiptId, duplicate: true };
    },
  });
  const result = await coordinator.deliverMatched(match);
  if (mode !== 'reconcile' ||
      result.status !== 'wake_delivered' ||
      result.wake?.runtimeReceiptId !== 'host-receipt:' + result.wake?.wakeId) {
    throw Object.assign(new Error('successor failed durable EI delivery'), {
      code: 'EI_EFFECT_RECONCILIATION_FAILED',
    });
  }
  await Promise.all([storePool.end(), hostPool.end()]);
  storePool = null; hostPool = null;
  process.send?.({
    type: 'reconciled', pid: process.pid, workerId,
    wakeId: result.wake.wakeId,
    receiptId: result.wake.runtimeReceiptId,
    status: result.status,
  });
} catch (error) {
  // No arbitrary error text or connection secrets over IPC.
  process.send?.({
    type: 'failed', stage,
    code: typeof error?.code === 'string'
      ? error.code : 'EI_EFFECT_WORKER_FAILED',
  });
  process.exitCode = 1;
  await Promise.allSettled([storePool?.end(), hostPool?.end()].filter(Boolean));
}
