import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';

const url = process.env.POSTGRES_URL;
const pg = url ? await import('pg') : null;
const Pool = pg?.Pool ?? pg?.default?.Pool;
const integration = url && process.platform !== 'win32' ? test : test.skip;
const fixture = new URL('./fixtures/postgres-post-host-effect-worker.mjs', import.meta.url);
const origin = Date.parse('2026-10-18T14:00:00.000Z');
const rounds = 3;
function iso(ms) { return new Date(ms).toISOString(); }

function launch(env, children, childExits) {
  const child = fork(fixture, [], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.add(child);
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
  });
  childExits.add(exited);
  void exited.then(() => childExits.delete(exited));
  const message = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error('effect-worker IPC timeout')), 9000,
    );
    function finish(error, value) {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(value);
    }
    function onMessage(value) {
      if (value?.type === 'failed') {
        finish(new Error('effect-worker failed: ' +
          value.stage + '/' + value.code));
      } else if (value?.type === 'host-effect-committed' ||
                 value?.type === 'reconciled') {
        finish(null, value);
      }
    }
    function onError(error) {
      finish(new Error('effect-worker child error ' + error?.code));
    }
    function onExit(code, signal) {
      finish(new Error('effect-worker exited before ACK ' + code +
        '/' + signal));
    }
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  return { child, message, exited };
}

function definition(round) {
  return {
    triggerId: 'post-effect-trigger-' + round,
    version: '1',
    clauses: [{
      id: 'changed', event: 'fixture.effect.changed',
      arguments: {},
      where: [{ path: 'round', op: 'eq', value: round }],
    }],
    pattern: { version: '2', root: { kind: 'event', ref: 'changed' } },
    withinMs: 60000,
    lifecycle: { oneShot: false, cooldownMs: 0, completeOnGoal: false },
    target: {
      runtime: 'idempotent-fixture-host',
      kind: 'task', id: 'fixture-task-' + round,
    },
  };
}
function event(round) {
  return {
    traceId: 'effect-trace-' + round,
    sourceEventId: 'effect-source-' + round,
    name: 'fixture.effect.changed',
    occurredAt: iso(origin + round * 10_000),
    serverId: 'fixture-provider',
    data: { round },
  };
}

integration('actual SIGKILL AFTER durable host effect BEFORE EI receipt reconciles exactly one host effect per wake', {
  timeout: 90000,
}, async () => {
  const prefix = 'ei_effect_' + randomBytes(5).toString('hex');
  const scopeId = 'post-effect-scope';
  const effectsTable = '"' + prefix + '_host_effects"';
  const attemptsTable = '"' + prefix + '_host_attempts"';
  const pool = new Pool({ connectionString: url, max: 3 });
  const host = new Pool({ connectionString: url, max: 3 });
  const children = new Set();
  const childExits = new Set();
  const reported = [];
  try {
    const store = new PostgresEventStore({
      pool, tablePrefix: prefix, scopeId,
    });
    await store.init();
    // Independent, operator-owned fixture tables. EI has no access to
    // these effects or their receipts except through deliverer responses.
    await host.query('CREATE TABLE ' + effectsTable +
      ' (wake_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL)');
    await host.query('CREATE TABLE ' + attemptsTable +
      ' (id BIGSERIAL PRIMARY KEY, wake_id TEXT NOT NULL,' +
      ' worker_id TEXT NOT NULL)');
    const engine = new CompositeTriggerEngine(store);
    for (let round = 0; round < rounds; round++) {
      const trigger = definition(round);
      await engine.register(trigger);
      const rows = await engine.ingest(event(round));
      const matched = rows.filter(row =>
        row.matched && row.match?.status === 'matched' &&
        row.triggerId === trigger.triggerId);
      assert.equal(matched.length, 1, 'must have exactly one durable match');
      const matchId = matched[0].match.matchId;
      const t0 = origin + round * 10_000 + 100;
      const common = {
        EI_EFFECT_PREFIX: prefix,
        EI_EFFECT_SCOPE: scopeId,
        EI_EFFECT_TRIGGER: trigger.triggerId,
        EI_EFFECT_MATCH: matchId,
      };
      const victim = launch({
        ...common, EI_EFFECT_MODE: 'post-effect-hold',
        EI_EFFECT_WORKER: 'victim-' + round, EI_EFFECT_NOW: iso(t0),
      }, children, childExits);
      const committed = await victim.message;
      assert.equal(committed.type, 'host-effect-committed');
      assert.equal(committed.matchId, matchId);
      assert.ok(committed.wakeId && committed.receiptId);
      assert.notEqual(committed.pid, process.pid);
      const priorEffects = await host.query(
        'SELECT receipt_id FROM ' + effectsTable + ' WHERE wake_id=$1',
        [committed.wakeId],
      );
      assert.equal(priorEffects.rows.length, 1);
      assert.equal(priorEffects.rows[0].receipt_id, committed.receiptId);
      const before = await store.getWakeDelivery(committed.wakeId);
      assert.equal(before.status, 'claimed');
      assert.equal(before.attemptCount, 1);
      assert.equal(before.runtimeReceiptId, null,
        'host effect exists but EI has not received any receipt');
      assert.equal(await store.claimWakeDelivery(committed.wakeId, {
        workerId: 'competing-early-worker', now: iso(t0 + 999),
        leaseMs: 1000,
      }), null, 'no duplicate retry before lease expiry');

      assert.equal(victim.child.kill('SIGKILL'), true);
      const killed = await victim.exited;
      assert.equal(killed.signal, 'SIGKILL');
      assert.equal((await store.getWakeDelivery(committed.wakeId)).status,
        'claimed');

      const replacement = launch({
        ...common, EI_EFFECT_MODE: 'reconcile',
        EI_EFFECT_WORKER: 'successor-' + round,
        EI_EFFECT_NOW: iso(t0 + 1000),
      }, children, childExits);
      const reconciled = await replacement.message;
      assert.equal((await replacement.exited).code, 0);
      assert.equal(reconciled.type, 'reconciled');
      assert.notEqual(reconciled.pid, committed.pid);
      assert.equal(reconciled.wakeId, committed.wakeId);
      assert.equal(reconciled.receiptId, committed.receiptId);

      const record = await store.getWakeDelivery(committed.wakeId);
      assert.equal(record.status, 'delivered');
      assert.equal(record.runtimeReceiptId, committed.receiptId);
      assert.equal(record.attemptCount, 2,
        'one orphaned claimed generation plus one recovered generation');
      assert.equal(await store.claimWakeDelivery(committed.wakeId, {
        workerId: 'late-after-delivery', now: iso(t0 + 3000),
      }), null);
      const effects = await host.query(
        'SELECT receipt_id FROM ' + effectsTable + ' WHERE wake_id=$1',
        [committed.wakeId],
      );
      const attempts = await host.query(
        'SELECT worker_id FROM ' + attemptsTable +
          ' WHERE wake_id=$1 ORDER BY id',
        [committed.wakeId],
      );
      assert.equal(effects.rows.length, 1,
        'the separately persisted host effect must exist exactly once');
      assert.deepEqual(attempts.rows.map(x => x.worker_id),
        ['victim-' + round, 'successor-' + round],
        'two at-least-once host delivery attempts expected');
      const fired = (await store.listTriggerMatches(trigger.triggerId))
        .find(row => row.matchId === matchId);
      assert.equal(fired.status, 'fired');
      assert.equal(fired.firedWakeId, committed.wakeId);
      reported.push(committed.wakeId);
    }
    const verifierPool = new Pool({ connectionString: url, max: 2 });
    try {
      const independent = new PostgresEventStore({
        pool: verifierPool, tablePrefix: prefix, scopeId,
      });
      await independent.init();
      for (const wakeId of reported) {
        const saved = await independent.getWakeDelivery(wakeId);
        assert.equal(saved.status, 'delivered');
        assert.equal(saved.attemptCount, 2);
        assert.equal(saved.runtimeReceiptId, 'host-receipt:' + wakeId);
      }
      const effects = await host.query(
        'SELECT COUNT(*)::int AS count FROM ' + effectsTable,
      );
      const attempts = await host.query(
        'SELECT COUNT(*)::int AS count FROM ' + attemptsTable,
      );
      assert.equal(effects.rows[0].count, rounds);
      assert.equal(attempts.rows[0].count, 2 * rounds);
    } finally {
      await verifierPool.end();
    }
  } finally {
    // SIGKILL only *requests* termination. Do not DROP fixture tables
    // while a child backend may still be running CREATE/claim writes.
    // Await actual child process exit (and PostgreSQL socket teardown)
    // before starting cleanup. On timeout, fail closed: leave isolated
    // tables instead of racing an active worker's transactions.
    for (const child of children) child.kill('SIGKILL');
    let reapTimer;
    try {
      await Promise.race([
        Promise.allSettled([...childExits]),
        new Promise((_, reject) => {
          reapTimer = setTimeout(
            () => reject(new Error('SIGKILL worker exits not reaped before cleanup')),
            7000,
          );
        }),
      ]);
    } finally {
      clearTimeout(reapTimer);
    }
    const cleanup = new Pool({ connectionString: url, max: 2 });
    try {
      for (const table of [attemptsTable, effectsTable]) {
        await cleanup.query('DROP TABLE IF EXISTS ' + table);
      }
      for (const kind of ['metadata','leases','history','records','counters']) {
        await cleanup.query('DROP TABLE IF EXISTS "' +
          prefix + '_' + kind + '" CASCADE');
      }
    } finally {
      await cleanup.end();
      await Promise.all([pool.end(), host.end()]);
    }
  }
});
