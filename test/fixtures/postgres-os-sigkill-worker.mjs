// Only a disposable test fixture. Separate Node OS process and PG pool.
import { Pool } from 'pg';
import { PostgresEventStore } from '../../scripts/lib/postgres-event-store.mjs';

const { POSTGRES_URL, EI_CHAOS_TABLE_PREFIX: tablePrefix,
  EI_CHAOS_SCOPE: scopeId, EI_CHAOS_WAKE_ID: wakeId,
  EI_CHAOS_PARTITION: partitionKey, EI_CHAOS_WORKER_ID: workerId,
  EI_CHAOS_NOW: now, EI_CHAOS_MODE: mode } = process.env;

let pool;
let stage = 'configuration';
try {
  if (!POSTGRES_URL || !tablePrefix || !scopeId || !wakeId ||
      !partitionKey || !workerId || !now ||
      !['claim-and-hold', 'recover-and-complete'].includes(mode)) {
    throw Object.assign(new Error('invalid worker fixture input'), {
      code: 'EI_CHAOS_WORKER_CONFIG_INVALID',
    });
  }
  pool = new Pool({
    connectionString: POSTGRES_URL, max: 2,
    connectionTimeoutMillis: 4000, query_timeout: 4000,
    statement_timeout: 4000,
  });
  const store = new PostgresEventStore({ pool, tablePrefix, scopeId });
  stage = 'init';
  await store.init();
  stage = 'claim';
  const [wake, partition] = await Promise.all([
    store.claimWakeDelivery(wakeId, { workerId, now, leaseMs: 1000 }),
    store.claimPartitionLease(partitionKey, { workerId, now, leaseMs: 1000 }),
  ]);
  if (!wake || !partition) {
    throw Object.assign(new Error('expected both claims'), {
      code: 'EI_CHAOS_CLAIM_UNAVAILABLE',
    });
  }
  if (wake.leaseOwner !== workerId || partition.workerId !== workerId) {
    throw Object.assign(new Error('wrong claim owner'), {
      code: 'EI_CHAOS_WRONG_OWNER',
    });
  }
  if (mode === 'claim-and-hold') {
    // Send only after both claims have committed and awaited. Parent waits
    // for this exact IPC acknowledgement before sending a genuine SIGKILL.
    process.send?.({
      type: 'claimed', pid: process.pid, wakeId,
      workerId, generation: wake.attemptCount,
      partitionOwner: partition.workerId,
      leaseUntil: wake.leaseUntil,
    });
    // Keep the real process alive. It never calls an external host.
    setInterval(() => {}, 60_000);
  } else {
    stage = 'complete';
    const receiptId = 'fixture-receipt-' + wakeId;
    const delivered = await store.completeWakeDelivery(wakeId, {
      workerId, attemptCount: wake.attemptCount,
      runtimeReceiptId: receiptId, now,
    });
    if (delivered?.status !== 'delivered' ||
        delivered?.runtimeReceiptId !== receiptId) {
      throw Object.assign(new Error('durable receipt missing'), {
        code: 'EI_CHAOS_RECEIPT_MISSING',
      });
    }
    await pool.end();
    pool = null;
    process.send?.({
      type: 'completed', pid: process.pid, wakeId,
      workerId, generation: wake.attemptCount,
      partitionOwner: partition.workerId,
      receiptId, leaseUntil: wake.leaseUntil,
    });
  }
} catch (error) {
  // Never forward DB connection strings or error objects across IPC.
  process.send?.({
    type: 'failed', stage,
    code: typeof error?.code === 'string' ? error.code : 'EI_CHAOS_WORKER_FAILED',
  });
  process.exitCode = 1;
  if (pool) await pool.end().catch(() => {});
}
