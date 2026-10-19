// Test-only actual OS process barrier AFTER a committed EI delivery receipt.
// No runtime hooks or production changes.
import { Pool } from 'pg';
import { PostgresEventStore } from '../../scripts/lib/postgres-event-store.mjs';
import { CompositeTriggerEngine } from '../../dist/src/composite/engine.js';
import { CompositeWakeCoordinator } from '../../scripts/lib/composite-wake-coordinator.mjs';

const { POSTGRES_URL: url, EI_RECEIPT_OS_PREFIX: prefix,
  EI_RECEIPT_OS_SCOPE: scopeId, EI_RECEIPT_OS_TRIGGER: triggerId,
  EI_RECEIPT_OS_MATCH: matchId, EI_RECEIPT_OS_MODE: mode,
  EI_RECEIPT_OS_WORKER: workerId } = process.env;
const effectsTable = '"' + prefix + '_host_effects"';
let pool = null;
let hostPool = null;
let stage = 'configure';
try {
  if (!url || !prefix || !scopeId || !triggerId || !matchId || !workerId ||
      !['commit-hold', 'recover', 'recheck'].includes(mode)) {
    throw Object.assign(new Error('invalid receipt kill fixture configuration'), {
      code: 'EI_RECEIPT_OS_CONFIG_INVALID',
    });
  }
  pool = new Pool({
    connectionString: url, max: 2,
    query_timeout: 5000, statement_timeout: 5000,
    connectionTimeoutMillis: 5000,
  });
  hostPool = new Pool({
    connectionString: url, max: 2,
    query_timeout: 5000, statement_timeout: 5000,
    connectionTimeoutMillis: 5000,
  });
  const store = new PostgresEventStore({ pool, tablePrefix: prefix, scopeId });
  stage = 'init';
  await store.init();
  const match = (await store.listTriggerMatches(triggerId))
    .find(row => row.matchId === matchId);
  if (!match || (!['matched', 'fired'].includes(match.status))) {
    throw Object.assign(new Error('missing match for restart'), {
      code: 'EI_RECEIPT_OS_MATCH_MISSING',
    });
  }
  if (mode === 'commit-hold') {
    const complete = store.completeWakeDelivery.bind(store);
    store.completeWakeDelivery = async (wakeId, options) => {
      stage = 'receipt-committed';
      const delivered = await complete(wakeId, options);
      if (delivered?.status !== 'delivered' ||
          delivered?.runtimeReceiptId !== 'host:' + wakeId) {
        throw Object.assign(new Error('receipt not durable'), {
          code: 'EI_RECEIPT_OS_DELIVERY_MISSING',
        });
      }
      // This signal is emitted AFTER the actual PostgreSQL transaction
      // returns, but BEFORE CompositeWakeCoordinator appends delivered
      // WakeRecord or fires the match. Parent SIGKILLs this process.
      process.send?.({
        type: 'receipt-committed', pid: process.pid, wakeId,
        receiptId: delivered.runtimeReceiptId,
        matchId, attemptCount: delivered.attemptCount,
      });
      setInterval(() => {}, 60000);
      return new Promise(() => {});
    };
  }
  stage = 'deliver';
  let hostCalls = 0;
  const coordinator = new CompositeWakeCoordinator({
    store, triggerEngine: new CompositeTriggerEngine(store),
    workerId,
    deliverer: async packet => {
      hostCalls++;
      if (mode !== 'commit-hold' || !packet.wake_id ||
          packet.trigger_match_id !== matchId) {
        throw Object.assign(new Error('recovered worker attempted host call'), {
          code: 'EI_RECEIPT_OS_HOST_REDISPATCH',
        });
      }
      const receiptId = 'host:' + packet.wake_id;
      const inserted = await hostPool.query(
        'INSERT INTO ' + effectsTable + ' (wake_id,receipt_id)' +
        ' VALUES ($1,$2) ON CONFLICT (wake_id) DO NOTHING RETURNING wake_id',
        [packet.wake_id, receiptId],
      );
      if (inserted.rowCount !== 1) {
        throw Object.assign(new Error('duplicate fixture host effect'), {
          code: 'EI_RECEIPT_OS_DUPLICATE_HOST_EFFECT',
        });
      }
      return { runtimeReceiptId: receiptId };
    },
  });
  const result = await coordinator.deliverMatched(match);
  if (mode === 'commit-hold') {
    throw Object.assign(new Error('held worker must not return'), {
      code: 'EI_RECEIPT_OS_BARRIER_BYPASSED',
    });
  }
  if ((mode === 'recover' && result.status !== 'wake_delivered') ||
      (mode === 'recheck' && result.status !== 'already_fired') ||
      !result.wake?.wakeId ||
      result.wake?.runtimeReceiptId !== 'host:' + result.wake?.wakeId ||
      hostCalls !== 0) {
    throw Object.assign(new Error('receipt recovery invalid'), {
      code: 'EI_RECEIPT_OS_RECOVERY_FAILED',
    });
  }
  const saved = await store.getWakeDelivery(result.wake.wakeId);
  const fired = (await store.listTriggerMatches(triggerId))
    .find(row => row.matchId === matchId);
  if (saved?.status !== 'delivered' || saved?.attemptCount !== 1 ||
      fired?.status !== 'fired' || fired.firedWakeId !== result.wake.wakeId) {
    throw Object.assign(new Error('recovery did not finalize persisted state'), {
      code: 'EI_RECEIPT_OS_FINALIZATION_MISSING',
    });
  }
  await Promise.all([pool.end(), hostPool.end()]);
  pool = null; hostPool = null;
  process.send?.({
    type: mode === 'recover' ? 'recovered' : 'rechecked',
    pid: process.pid, wakeId: result.wake.wakeId,
    receiptId: result.wake.runtimeReceiptId,
    matchId, status: result.status, hostCalls,
  });
} catch (error) {
  process.send?.({
    type: 'failed', stage,
    code: typeof error?.code === 'string' ? error.code : 'EI_RECEIPT_OS_FAILED',
  });
  process.exitCode = 1;
  await Promise.allSettled([pool?.end(), hostPool?.end()].filter(Boolean));
}
