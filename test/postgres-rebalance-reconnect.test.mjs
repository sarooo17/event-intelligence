import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';

const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integrationTest = url ? test : test.skip;

integrationTest('repeated physical worker disconnects preserve rebalance leases, wake fencing and receipts', async () => {
  // Every round closes an actual pg.Pool before reconstructing that worker,
  // rather than just changing its JavaScript identity in one shared pool.
  const prefix = 'ei_rebalance_' + randomBytes(6).toString('hex');
  const scopeId = 'reconnect-rebalance';
  const origin = Date.parse('2026-10-11T05:00:00.000Z');
  const rounds = 12;
  const pools = [
    new Pool({ connectionString: url, max: 4 }),
    new Pool({ connectionString: url, max: 4 }),
  ];
  const at = (ms) => new Date(ms).toISOString();
  const createStore = (db) => new PostgresEventStore({
    pool: db, dispatchPoolIdentity: db, scopeId, tablePrefix: prefix,
  });
  const stores = pools.map(createStore);
  const wakeIds = [];
  try {
    await Promise.all(stores.map(store => store.init()));

    for (let round = 0; round < rounds; round += 1) {
      const crashed = round % 2;
      const peer = 1 - crashed;
      const original = stores[crashed];
      const t0 = origin + round * 20_000;
      const wakeId = 'rebalance-wake-' + round;
      const partition = 'rebalance-partition-' + (round % 4) + ':' + round;
      const workerId = 'worker-' + crashed;

      await original.ensureWakeDelivery({
        wakeId,
        matchId: 'rebalance-match-' + round,
        triggerId: 'rebalance-trigger',
        triggerVersion: '1',
        runtime: 'ha-rebalance-fixture',
        now: at(t0),
      });
      const firstWake = await original.claimWakeDelivery(wakeId, {
        workerId, now: at(t0), leaseMs: 1000,
      });
      const firstPartition = await original.claimPartitionLease(partition, {
        workerId, now: at(t0), leaseMs: 1000,
      });
      assert.ok(firstWake, 'round ' + round + ': initial wake claim missing');
      assert.ok(firstPartition, 'round ' + round + ': initial partition claim missing');
      assert.equal(firstPartition.workerId, workerId, 'round ' + round + ': initial partition owner');
      assert.equal(firstPartition.leaseUntil, at(t0 + 1000), 'round ' + round + ': initial partition expiry');
      assert.equal(firstWake.attemptCount, 1);

      // Peer cannot steal either claim before expiry even during rebalance.
      assert.equal(await stores[peer].claimWakeDelivery(wakeId, {
        workerId: 'worker-' + peer, now: at(t0 + 999), leaseMs: 1000,
      }), null);
      assert.equal(await stores[peer].claimPartitionLease(partition, {
        workerId: 'worker-' + peer, now: at(t0 + 999), leaseMs: 1000,
      }), null);

      // Terminate the physical original pool and create an independent one.
      await pools[crashed].end();
      pools[crashed] = null;
      pools[crashed] = new Pool({ connectionString: url, max: 4 });
      stores[crashed] = createStore(pools[crashed]);
      await stores[crashed].init();

      const persisted = await stores[peer].getWakeDelivery(wakeId);
      assert.equal(persisted.status, 'claimed');
      assert.equal(persisted.runtimeReceiptId, null);

      // Alternate between same-ID ABA reclaims and actual worker handovers.
      const successor = round % 3 === 0 ? crashed : peer;
      const successorId = 'worker-' + successor;
      const recoveredPartition = await stores[successor].claimPartitionLease(
        partition, { workerId: successorId, now: at(t0 + 1000), leaseMs: 1000 },
      );
      assert.ok(recoveredPartition, 'round ' + round + ': partition handover missing');
      assert.equal(recoveredPartition.workerId, successorId, 'round ' + round + ': partition takeover owner');
      assert.equal(recoveredPartition.leaseUntil, at(t0 + 2000), 'round ' + round + ': renewed partition expiry');
      const independentlyReadPartition = await stores[1 - successor].getPartitionLease(partition);
      assert.equal(independentlyReadPartition?.workerId, successorId, 'round ' + round + ': durable partition owner');
      assert.equal(independentlyReadPartition?.leaseUntil, at(t0 + 2000), 'round ' + round + ': durable partition expiry');
      const newWake = await stores[successor].claimWakeDelivery(wakeId, {
        workerId: successorId, now: at(t0 + 1000), leaseMs: 1000,
      });
      assert.ok(newWake, 'round ' + round + ': expired wake not reclaimable');
      assert.equal(newWake.attemptCount, 2, 'round ' + round);

      // The old claim generation is rejected even after the original worker
      // returns using the same stable logical worker ID.
      await assert.rejects(
        () => stores[crashed].completeWakeDelivery(wakeId, {
          workerId, attemptCount: firstWake.attemptCount,
          runtimeReceiptId: 'stale-' + round,
          now: at(t0 + 1100),
        }),
        err => err?.code === 'WAKE_DELIVERY_CLAIM_LOST',
      );
      const delivered = await stores[successor].completeWakeDelivery(wakeId, {
        workerId: successorId,
        attemptCount: newWake.attemptCount,
        runtimeReceiptId: 'receipt-' + round,
        now: at(t0 + 1200),
      });
      assert.equal(delivered.runtimeReceiptId, 'receipt-' + round);
      assert.equal(delivered.status, 'delivered');

      const opposite = stores[1 - successor];
      const reread = await opposite.getWakeDelivery(wakeId);
      assert.equal(reread.runtimeReceiptId, 'receipt-' + round);
      assert.equal(await opposite.claimWakeDelivery(wakeId, {
        workerId: 'late-' + round,
        now: at(t0 + 3000), leaseMs: 1000,
      }), null, 'delivered wake must never be redispatched');
      wakeIds.push(wakeId);
    }

    // A final independent physical pool must see all durable receipts.
    const auditor = new Pool({ connectionString: url, max: 2 });
    try {
      const independent = createStore(auditor);
      await independent.init();
      for (const [round, wakeId] of wakeIds.entries()) {
        const receipt = await independent.getWakeDelivery(wakeId);
        assert.equal(receipt.status, 'delivered', 'round ' + round);
        assert.equal(receipt.attemptCount, 2, 'round ' + round);
        assert.equal(receipt.runtimeReceiptId, 'receipt-' + round);
      }
    } finally {
      await auditor.end();
    }
  } finally {
    // Isolated unique test schema; never touch operator-provided tables.
    const cleanup = new Pool({ connectionString: url, max: 2 });
    try {
      for (const kind of ['metadata', 'leases', 'history', 'records', 'counters']) {
        await cleanup.query('DROP TABLE IF EXISTS "' + prefix + '_' + kind + '" CASCADE');
      }
    } finally {
      await cleanup.end();
      await Promise.all(pools.filter(Boolean).map(pool => pool.end()));
    }
  }
});
