import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';

const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integration = url ? test : test.skip;
const ISO_BASE = Date.parse('2026-10-20T12:00:00.000Z');
const at = ms => new Date(ms).toISOString();
const kinds = ['metadata', 'leases', 'history', 'records', 'counters'];

integration('actual PG backend termination preserves durable wake claims, fencing and receipts across independent pools', {
  timeout: 120_000,
}, async () => {
  const prefix = 'ei_bkill_' + randomBytes(6).toString('hex');
  const scopeId = 'backend-kill-fixture';
  const makePool = () => {
    const pool = new Pool({ connectionString: url, max: 4,
      connectionTimeoutMillis: 5000, query_timeout: 12000 });
    // Physical server-side disconnects may emit idle pool errors. A test
    // must observe those, not turn them into uncaught process exceptions.
    pool.on('error', () => {});
    return pool;
  };
  const dbs = [makePool(), makePool()];
  const makeStore = pool => new PostgresEventStore({
    pool, dispatchPoolIdentity: pool, scopeId, tablePrefix: prefix,
  });
  const stores = dbs.map(makeStore);
  const controller = makePool();
  try {
    await Promise.all(stores.map(store => store.init()));
    for (let round = 0; round < 4; round++) {
      const t0 = ISO_BASE + round * 20_000;
      const wakeId = 'backend-kill-wake-' + round;
      const partition = 'backend-kill-partition-' + round;
      const originalId = 'worker-original-' + round;
      await stores[0].ensureWakeDelivery({
        wakeId, matchId: 'backend-kill-match-' + round,
        triggerId: 'backend-kill-trigger', triggerVersion: '1',
        runtime: 'pg-backend-kill-fixture', now: at(t0),
      });
      const first = await stores[0].claimWakeDelivery(wakeId, {
        workerId: originalId, now: at(t0), leaseMs: 1000,
      });
      const lease = await stores[0].claimPartitionLease(partition, {
        workerId: originalId, now: at(t0), leaseMs: 1000,
      });
      assert.equal(first?.attemptCount, 1);
      assert.equal(lease?.workerId, originalId);
      assert.equal((await stores[1].getWakeDelivery(wakeId))?.runtimeReceiptId, null);

      // Kill a *real* PostgreSQL backend while a SQL operation is pending.
      // This deliberately exercises a server-side socket loss, unlike
      // closing an application pg.Pool or only advancing a fixture clock.
      const client = await dbs[0].connect();
      client.on('error', () => {});
      try {
        const pidResult = await client.query('SELECT pg_backend_pid() AS pid');
        const pid = Number(pidResult.rows[0]?.pid);
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        const pending = client.query('SELECT pg_sleep(10)');
        // Install the rejection handler BEFORE terminating the connection:
        // otherwise Node 22 can surface an unhandled rejection while the
        // independent controller's terminate query is still in flight.
        const expectedFailure = assert.rejects(
          pending, 'in-flight SQL must fail on physical backend termination',
        );
        // Prove SQL is running on this backend rather than merely assuming
        // a sleep on the JavaScript side means the query was dispatched.
        let active = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const observed = await controller.query(
            "SELECT state, query FROM pg_stat_activity WHERE pid=$1", [pid],
          );
          if (observed.rows[0]?.state === 'active' &&
              observed.rows[0]?.query?.includes('SELECT pg_sleep(10)')) {
            active = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(active, true, 'PG backend must be actively executing pg_sleep');
        const killed = await controller.query(
          'SELECT pg_terminate_backend($1) AS killed', [pid],
        );
        assert.equal(killed.rows[0]?.killed, true);
        await expectedFailure;
      } finally {
        client.release(true);
      }
      // Restart the victim's physical pool, then check *other* workers
      // never observe a fabricated receipt or premature claim takeover.
      await dbs[0].end();
      dbs[0] = makePool();
      stores[0] = makeStore(dbs[0]);
      await stores[0].init();
      const persisted = await stores[1].getWakeDelivery(wakeId);
      assert.equal(persisted?.status, 'claimed');
      assert.equal(persisted?.runtimeReceiptId, null);
      assert.equal(await stores[1].claimWakeDelivery(wakeId, {
        workerId: 'too-early', now: at(t0 + 999), leaseMs: 1000,
      }), null);
      assert.equal(await stores[1].claimPartitionLease(partition, {
        workerId: 'too-early', now: at(t0 + 999), leaseMs: 1000,
      }), null, 'partition lease must also reject a pre-expiry contender');

      const successorId = round % 2 === 0
        ? originalId : 'worker-successor-' + round;
      const renewed = await stores[1].claimPartitionLease(partition, {
        workerId: successorId, now: at(t0 + 1000), leaseMs: 1000,
      });
      assert.equal(renewed?.workerId, successorId);
      assert.equal(renewed?.leaseUntil, at(t0 + 2000));
      const reclaimed = await stores[1].claimWakeDelivery(wakeId, {
        workerId: successorId, now: at(t0 + 1000), leaseMs: 1000,
      });
      assert.equal(reclaimed?.attemptCount, 2);
      await assert.rejects(
        () => stores[0].completeWakeDelivery(wakeId, {
          workerId: originalId, attemptCount: first.attemptCount,
          runtimeReceiptId: 'stale-' + round, now: at(t0 + 1100),
        }),
        error => error?.code === 'WAKE_DELIVERY_CLAIM_LOST',
      );
      await stores[1].completeWakeDelivery(wakeId, {
        workerId: successorId, attemptCount: reclaimed.attemptCount,
        runtimeReceiptId: 'receipt-' + round, now: at(t0 + 1200),
      });
      const durable = await stores[0].getWakeDelivery(wakeId);
      assert.equal(durable?.status, 'delivered');
      assert.equal(durable?.attemptCount, 2);
      assert.equal(durable?.runtimeReceiptId, 'receipt-' + round);
      assert.equal(await stores[0].claimWakeDelivery(wakeId, {
        workerId: 'late', now: at(t0 + 5000), leaseMs: 1000,
      }), null, 'delivered wake must never be redistributed');
    }
  } finally {
    // An isolated random table prefix guarantees no production tables are
    // touched. Cleanup failure must fail the test, never certify recovery.
    try {
      const cleanup = makePool();
      try {
        for (const kind of kinds) {
          await cleanup.query('DROP TABLE IF EXISTS "' + prefix +
            '_' + kind + '" CASCADE');
        }
      } finally {
        await cleanup.end();
      }
    } finally {
      await Promise.allSettled([...dbs, controller].map(p => p.end()));
    }
  }
});
