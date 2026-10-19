import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';

import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';

const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integration = url && process.platform !== 'win32' ? test : test.skip;
const fixture = new URL('./fixtures/postgres-os-sigkill-worker.mjs', import.meta.url);
const TABLES = ['metadata', 'leases', 'history', 'records', 'counters'];
const configuredRounds = process.env.EI_CHAOS_ROUNDS ?? '6';
const ROUNDS = Number(configuredRounds);
if (!Number.isSafeInteger(ROUNDS) || ROUNDS < 1 || ROUNDS > 120) {
  throw new TypeError('EI_CHAOS_ROUNDS must be an integer from 1 to 120');
}
const leaseMs = 1000;
const origin = Date.parse('2026-10-18T12:00:00.000Z');

function at(value) { return new Date(value).toISOString(); }

function forkWorker(env, liveChildren, childExits) {
  const child = fork(fixture, [], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  liveChildren.add(child);
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      liveChildren.delete(child);
      resolve({ code, signal });
    });
  });
  childExits.add(exited);
  void exited.then(() => childExits.delete(exited));
  const result = new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error('OS worker IPC deadline exceeded')), 7000,
    );
    function finish(error, value) {
      clearTimeout(deadline);
      child.off('message', message);
      child.off('error', errorHandler);
      child.off('exit', exitHandler);
      if (error) reject(error);
      else resolve(value);
    }
    function message(value) {
      if (value?.type === 'failed') {
        finish(new Error('OS worker failed at ' + value.stage +
          ' with code ' + value.code));
      } else if (value?.type === 'claimed' || value?.type === 'completed') {
        finish(null, value);
      }
    }
    function errorHandler(err) {
      finish(new Error('OS worker process failure: ' + err?.code));
    }
    function exitHandler(code, signal) {
      finish(new Error('OS worker exited before IPC: ' +
        String(code) + '/' + String(signal)));
    }
    child.on('message', message);
    child.once('error', errorHandler);
    child.once('exit', exitHandler);
  });
  return { child, result, exited };
}

integration('real SIGKILL PostgreSQL worker takeovers fence generations and keep distinct durable receipts', {
  timeout: Math.max(95000, ROUNDS * 12000),
}, async () => {
  const tablePrefix = 'ei_kill_' + randomBytes(5).toString('hex');
  const scopeId = 'sigkill-fixture';
  const pool = new Pool({
    connectionString: url, max: 3,
    connectionTimeoutMillis: 5000, query_timeout: 5000,
    statement_timeout: 5000,
  });
  const liveChildren = new Set();
  const childExits = new Set();
  const wakeIds = [];
  const rawRounds = [];
  const testStart = process.hrtime.bigint();
  try {
    const store = new PostgresEventStore({ pool, tablePrefix, scopeId });
    await store.init();
    for (let round = 0; round < ROUNDS; round++) {
      const started = process.hrtime.bigint();
      const wakeId = 'os-kill-wake-' + round;
      const partitionKey = 'os-kill-partition-' + round;
      const t0 = origin + round * 10_000;
      const originalWorkerId = 'logical-worker-a';
      // Test genuine cross-process takeover and also a new PID reusing
      // the same logical worker ID (ABA generation fencing).
      const successorWorkerId = round % 2 === 0
        ? originalWorkerId : 'logical-worker-b';
      const common = {
        EI_CHAOS_TABLE_PREFIX: tablePrefix,
        EI_CHAOS_SCOPE: scopeId,
        EI_CHAOS_WAKE_ID: wakeId,
        EI_CHAOS_PARTITION: partitionKey,
      };
      await store.ensureWakeDelivery({
        wakeId, matchId: 'os-kill-match-' + round,
        triggerId: 'os-kill-trigger', triggerVersion: '1',
        runtime: 'test-only-host', now: at(t0),
      });
      const victim = forkWorker({
        ...common, EI_CHAOS_MODE: 'claim-and-hold',
        EI_CHAOS_WORKER_ID: originalWorkerId,
        EI_CHAOS_NOW: at(t0),
      }, liveChildren, childExits);
      const original = await victim.result;
      assert.equal(original.type, 'claimed');
      assert.equal(original.generation, 1);
      assert.equal(original.partitionOwner, originalWorkerId);
      assert.equal(original.leaseUntil, at(t0 + leaseMs));
      const beforeKill = await store.getWakeDelivery(wakeId);
      assert.equal(beforeKill.status, 'claimed');
      assert.equal(beforeKill.attemptCount, 1);
      assert.equal(beforeKill.runtimeReceiptId, null,
        'there must be NO external host delivery in the victim boundary');

      // The other worker cannot claim before expiry, even after victim
      // committed the wake/partition claims.
      assert.equal(await store.claimWakeDelivery(wakeId, {
        workerId: 'competing-peer', now: at(t0 + leaseMs - 1),
        leaseMs,
      }), null);
      assert.equal(await store.claimPartitionLease(partitionKey, {
        workerId: 'competing-peer', now: at(t0 + leaseMs - 1),
        leaseMs,
      }), null);
      assert.equal(victim.child.kill('SIGKILL'), true,
        'real OS worker must accept SIGKILL');
      const dead = await victim.exited;
      assert.equal(dead.signal, 'SIGKILL',
        'test must prove OS kill, not just PG pool disconnect');
      assert.notEqual(original.pid, process.pid);
      const afterKill = await store.getWakeDelivery(wakeId);
      assert.equal(afterKill.status, 'claimed');
      assert.equal(afterKill.attemptCount, 1);
      assert.equal(afterKill.runtimeReceiptId, null);
      const oldLease = await store.getPartitionLease(partitionKey);
      assert.equal(oldLease.workerId, originalWorkerId);

      // Recovery time is explicitly advanced to the lease boundary.
      // This avoids 6 real wall-clock sleeps; the OS SIGKILL remains real.
      const successor = forkWorker({
        ...common, EI_CHAOS_MODE: 'recover-and-complete',
        EI_CHAOS_WORKER_ID: successorWorkerId,
        EI_CHAOS_NOW: at(t0 + leaseMs),
      }, liveChildren, childExits);
      const result = await successor.result;
      const completed = await successor.exited;
      assert.equal(completed.code, 0, 'successor must exit cleanly');
      assert.equal(result.type, 'completed');
      assert.notEqual(result.pid, original.pid);
      assert.equal(result.workerId, successorWorkerId);
      assert.equal(result.partitionOwner, successorWorkerId);
      assert.equal(result.generation, 2);
      assert.equal(result.receiptId, 'fixture-receipt-' + wakeId);
      const persisted = await store.getWakeDelivery(wakeId);
      assert.equal(persisted.status, 'delivered');
      assert.equal(persisted.runtimeReceiptId, result.receiptId);
      assert.equal(persisted.attemptCount, 2);
      assert.equal(persisted.leaseOwner, null);
      assert.equal(await store.claimWakeDelivery(wakeId, {
        workerId: 'post-delivery-competitor',
        now: at(t0 + leaseMs * 3), leaseMs,
      }), null, 'durably delivered wake cannot be reclaimed');

      await assert.rejects(
        () => store.completeWakeDelivery(wakeId, {
          workerId: originalWorkerId, attemptCount: 1,
          runtimeReceiptId: 'stale-bad-receipt',
          now: at(t0 + leaseMs + 10),
        }),
        err => err?.code === 'WAKE_DELIVERY_CLAIM_LOST',
        'stale killed-worker claim must never overwrite receipt',
      );
      assert.equal((await store.getWakeDelivery(wakeId)).runtimeReceiptId,
        result.receiptId);
      wakeIds.push(wakeId);
      rawRounds.push({
        round, victimPid: original.pid, successorPid: result.pid,
        workerId: successorWorkerId, generation: result.generation,
        receiptId: result.receiptId, killedSignal: dead.signal,
        handoverMs: Number(process.hrtime.bigint() - started) / 1e6,
      });
    }

    // Audit from an independent physical pool after every victim was
    // SIGKILLed and each successor exited normally.
    const auditPool = new Pool({ connectionString: url, max: 2 });
    try {
      const auditor = new PostgresEventStore({
        pool: auditPool, scopeId, tablePrefix,
      });
      await auditor.init();
      for (let i = 0; i < ROUNDS; i++) {
        const wakeId = wakeIds[i];
        const saved = await auditor.getWakeDelivery(wakeId);
        assert.equal(saved.status, 'delivered');
        assert.equal(saved.attemptCount, 2);
        assert.equal(saved.runtimeReceiptId, 'fixture-receipt-' + wakeId);
        assert.equal((await auditor.getPartitionLease(
          'os-kill-partition-' + i,
        )).workerId, i % 2 === 0 ? 'logical-worker-a' : 'logical-worker-b');
      }
    } finally {
      await auditPool.end();
    }
    const timings = rawRounds.map(r => r.handoverMs).sort((a,b) => a-b);
    const percentile = p => timings[Math.min(timings.length - 1, Math.ceil(p * timings.length) - 1)];
    const report = {
      schema: 'ei-postgres-os-chaos-v1',
      kind: 'bounded-process-kill-and-reclaim',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      postgresVersion: (await pool.query('SHOW server_version')).rows[0]?.server_version,
      rounds: ROUNDS,
      killsConfirmed: rawRounds.filter(r => r.killedSignal === 'SIGKILL').length,
      recoveredReceipts: wakeIds.length,
      totalDurationMs: Number(process.hrtime.bigint() - testStart) / 1e6,
      handoverMs: {p50: percentile(.50), p95: percentile(.95), p99: percentile(.99)},
      evidence: rawRounds,
      limits: 'single PG16 instance, synthetic claims only; no provider/match/wake end-to-end or network partition',
    };
    if (process.env.EI_CHAOS_EVIDENCE_OUT) {
      await writeFile(process.env.EI_CHAOS_EVIDENCE_OUT,
        JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    }
  } finally {
    try {
      for (const child of liveChildren) child.kill('SIGKILL');
      let timer;
      try {
        await Promise.race([
          Promise.allSettled([...childExits]),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(
              'child processes were not reaped; preserve unsafe tables',
            )), 7000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      for (const suffix of TABLES) {
        await pool.query('DROP TABLE IF EXISTS "' +
          tablePrefix + '_' + suffix + '" CASCADE');
      }
    } finally {
      await pool.end();
    }
  }
});
