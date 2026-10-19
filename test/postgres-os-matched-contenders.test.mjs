import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';

import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';

const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integration = url && process.platform !== 'win32' ? test : test.skip;
const workerFile = new URL('./fixtures/postgres-os-match-wake-worker.mjs', import.meta.url);
const configured = Number(process.env.EI_MATCH_KILL_ROUNDS ?? '4');
if (!Number.isSafeInteger(configured) || configured < 1 || configured > 30) {
  throw new TypeError('EI_MATCH_KILL_ROUNDS must be in 1..30');
}
const rounds = configured;
const schemaTables = ['metadata', 'leases', 'history', 'records', 'counters'];
const origin = Date.parse('2026-10-18T10:00:00.000Z');
const at = round => new Date(origin + round * 1000).toISOString();

function definition(round) {
  return {
    triggerId: 'os-match-before-wake-' + round, version: '1',
    clauses: [{
      id: 'ready', event: 'fixture.os.match.ready', arguments: {},
      where: [{ path: 'round', op: 'eq', value: round }],
    }],
    pattern: { version: '2', root: { kind: 'event', ref: 'ready' } },
    withinMs: 60000,
    lifecycle: { oneShot: false, cooldownMs: 0, completeOnGoal: false },
    target: { runtime: 'fixture-host', kind: 'task', id: 'wake-' + round },
  };
}
function occurrence(round) {
  return {
    eventId: 'os-matched-event-' + round, name: 'fixture.os.match.ready',
    timestamp: at(round), data: { round },
  };
}

function spawn(mode, round, prefix, children, exits, workerId) {
  const child = fork(workerFile, [], {
    env: {
      ...process.env,
      EI_MATCH_KILL_PREFIX: prefix,
      EI_MATCH_KILL_SCOPE: 'os-matched-tenant',
      EI_MATCH_KILL_ROUND: String(round),
      EI_MATCH_KILL_MODE: mode, EI_MATCH_KILL_WORKER: workerId,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.add(child);
  const messages = [];
  let waiter = null;
  let dead = null;
  const next = (type, timeoutMs = 11000) => new Promise((resolve, reject) => {
    if (waiter) return reject(new Error('only one outstanding IPC receive per child'));
    let timer;
    const settle = (err, value) => {
      clearTimeout(timer);
      waiter = null;
      if (err) reject(err); else resolve(value);
    };
    const inspect = value => {
      if (value?.type === 'failed') {
        settle(new Error('OS matched worker failure: ' + value.stage + '/' + value.code));
      } else if (value?.type !== type) {
        settle(new Error('unexpected OS IPC: expected ' + type + ', got ' + value?.type));
      } else {
        settle(null, value);
      }
    };
    if (messages.length > 0) return inspect(messages.shift());
    if (dead) return settle(new Error('OS worker exited before ' + type));
    waiter = inspect;
    timer = setTimeout(() => settle(new Error('OS ' + type + ' IPC deadline exceeded')), timeoutMs);
  });
  child.on('message', msg => {
    if (waiter) waiter(msg);
    else messages.push(msg);
  });
  child.on('error', err => {
    const failed = { type: 'failed', stage: 'child-process', code: err?.code ?? 'UNKNOWN' };
    if (waiter) waiter(failed);
    else messages.push(failed);
  });
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      dead = { code, signal };
      children.delete(child);
      if (waiter) waiter({ type: 'failed', stage: 'unexpected-exit', code: code ?? signal });
      resolve(dead);
    });
  });
  exits.add(exited);
  void exited.then(() => exits.delete(exited));
  return { child, next, exited };
}

async function boundedExit(worker, label, deadlineMs = 6000) {
  let timeout;
  try {
    const result = await Promise.race([
      worker.exited,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          worker.child.kill('SIGKILL');
          reject(new Error(label + ' did not exit; SIGKILL sent'));
        }, deadlineMs);
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

integration('real OS SIGKILL after MCP Pattern match: independent PG workers contend and persist exactly one host effect', {
  timeout: Math.max(95000, rounds * 15000),
}, async () => {
  const prefix = 'ei_mwkill_' + randomBytes(5).toString('hex');
  const scopeId = 'os-matched-tenant';
  const pool = new Pool({
    connectionString: url, max: 4, connectionTimeoutMillis: 5000,
    query_timeout: 5000, statement_timeout: 5000,
  });
  const children = new Set(), exits = new Set();
  const evidence = [];
  const started = process.hrtime.bigint();
  try {
    const store = new PostgresEventStore({ pool, scopeId, tablePrefix: prefix });
    await store.init();
    await pool.query('CREATE TABLE "' + prefix + '_host_effects" (' +
      'wake_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL)');
    await pool.query('CREATE TABLE "' + prefix + '_host_attempts" (' +
      'id BIGSERIAL PRIMARY KEY, wake_id TEXT NOT NULL, worker_id TEXT NOT NULL)');
    const engine = new CompositeTriggerEngine(store);
    for (let round = 0; round < rounds; round++) {
      await engine.register(definition(round));
      const victim = spawn('persist-match-hold', round, prefix, children, exits, 'logical-victim');
      const matched = await victim.next('matched');
      assert.notEqual(matched.pid, process.pid);
      const saved = (await store.listTriggerMatches(definition(round).triggerId))
        .find(row => row.matchId === matched.matchId);
      assert.equal(saved?.status, 'matched');
      assert.deepEqual(await store.listDueWakeDeliveries(at(round)), [],
        'persisted logical match must precede any wake claim');
      assert.equal(victim.child.kill('SIGKILL'), true);
      const dead = await boundedExit(victim, 'matched victim');
      assert.equal(dead.signal, 'SIGKILL', 'a genuine OS kill is required');

      // Two separate processes with independent PostgreSQL pools both see
      // the same committed logical match. Neither inherits victim state.
      const left = spawn('contend-delivery', round, prefix, children, exits, 'logical-peer-a');
      const right = spawn('contend-delivery', round, prefix, children, exits, 'logical-peer-b');
      const ready = await Promise.all([left.next('ready'), right.next('ready')]);
      assert.ok(ready.every(row => row.matchId === matched.matchId));
      left.child.send({ type: 'go' });
      right.child.send({ type: 'go' });
      const outcomes = await Promise.all([left.next('completed'), right.next('completed')]);
      const completed = await Promise.all([
        boundedExit(left, 'peer-a'), boundedExit(right, 'peer-b'),
      ]);
      assert.ok(completed.every(row => row.code === 0));
      assert.equal(outcomes.filter(row => row.status === 'wake_delivered').length, 1,
        'one claimed wake must win cross-process race');
      assert.ok(outcomes.every(row =>
        row.status === 'wake_delivered' || row.status === 'delivery_in_progress'));
      assert.equal(outcomes.reduce((sum, row) => sum + row.hostCalls, 0), 1,
        'two competing physical workers must invoke the host at most once');

      const latest = (await store.listTriggerMatches(definition(round).triggerId))
        .find(row => row.matchId === matched.matchId);
      assert.equal(latest?.status, 'fired', 'real EI match must be fully finalized');
      const wakeId = latest.firedWakeId;
      const delivery = await store.getWakeDelivery(wakeId);
      assert.equal(delivery?.status, 'delivered');
      assert.equal(delivery?.attemptCount, 1);
      assert.equal(delivery?.runtimeReceiptId, 'fixture-external:' + wakeId);
      assert.equal((await store.latestWake(wakeId))?.status, 'delivered');
      const effects = (await pool.query(
        'SELECT wake_id,receipt_id FROM "' + prefix + '_host_effects" WHERE wake_id=$1',
        [wakeId],
      )).rows;
      const attempts = (await pool.query(
        'SELECT worker_id FROM "' + prefix + '_host_attempts" WHERE wake_id=$1',
        [wakeId],
      )).rows;
      assert.equal(effects.length, 1, 'exactly one durable external fixture effect');
      assert.equal(attempts.length, 1, 'no hidden duplicate external host invocation');
      assert.equal(effects[0].receipt_id, delivery.runtimeReceiptId);

      // Replaying the exact same MCP occurrence on a third independent
      // engine cannot invoke the host again or create another logical match.
      const replayCoordinator = new CompositeWakeCoordinator({
        store, triggerEngine: new CompositeTriggerEngine(store),
        workerId: 'logical-post-recovery-replay-' + round,
        deliverer: async () => { throw new Error('forbidden host redispatch after recovery'); },
      });
      const replay = await new CompositeEventConsumer({
        store, triggerEngine: new CompositeTriggerEngine(store),
        wakeCoordinator: replayCoordinator,
      }).ingestMcpOccurrence({
        event: occurrence(round), serverId: 'fixture-mcp-server',
        provider: 'fixture-mcp-source', traceId: 'os-matched-trace-' + round,
      });
      assert.equal(replay.deliveries.length, 1);
      assert.equal(replay.deliveries[0].status, 'already_fired');
      assert.equal((await store.listTriggerMatches(definition(round).triggerId))
        .filter(row => row.matchId === matched.matchId).length, 1);
      evidence.push({
        round, killedPid: matched.pid, signal: dead.signal,
        successorPids: outcomes.map(row => row.pid), matchId: matched.matchId,
        wakeId, attempts: attempts.length, effects: effects.length,
        deliveryGeneration: delivery.attemptCount, receiptId: delivery.runtimeReceiptId,
      });
    }
    assert.equal(await store.verifyAudit(), true);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM "' +
      prefix + '_host_effects"')).rows[0].n, rounds);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM "' +
      prefix + '_host_attempts"')).rows[0].n, rounds);
    const report = {
      schema: 'ei-postgres-os-matched-contenders-v1',
      rounds, killedAfterPersistedMatch: evidence.length,
      committedUniqueMatches: evidence.length,
      recoveredDurableReceipts: evidence.length,
      externalHostAttempts: rounds, externalHostEffects: rounds,
      observedDuplicateHostAttempts: 0,
      totalWallMs: Number(process.hrtime.bigint() - started) / 1e6,
      limits: 'same PG16 instance, 2 competing worker processes, simulated MCP occurrence, fixture host ledger; no real provider network, database partition/failover or durable upstream cursor',
      evidence,
    };
    if (process.env.EI_MATCH_KILL_EVIDENCE_OUT) {
      await writeFile(process.env.EI_MATCH_KILL_EVIDENCE_OUT,
        JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    }
  } finally {
    // Never drop isolated tables while children can still use them.
    for (const child of children) child.kill('SIGKILL');
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([...exits]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            'OS matching workers were not fully reaped; unsafe to drop tables',
          )), 7000);
        }),
      ]);
      await pool.query('DROP TABLE IF EXISTS ' +
        [...schemaTables.map(x => '"' + prefix + '_' + x + '"'),
          '"' + prefix + '_host_effects"', '"' + prefix + '_host_attempts"'].join(', ') +
        ' CASCADE');
    } finally {
      clearTimeout(timer);
      await pool.end();
    }
  }
});
