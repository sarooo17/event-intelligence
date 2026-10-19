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
const fixture = new URL('./fixtures/postgres-post-receipt-sigkill-worker.mjs', import.meta.url);
const kinds = ['metadata', 'leases', 'history', 'records', 'counters'];
const rounds = 3;

function definition(round) {
  return {
    triggerId: 'post-ei-receipt-os-' + round,
    version: '1',
    clauses: [{
      id: 'ready', event: 'receipt.fixture.ready',
      arguments: {}, where: [{ path: 'round', op: 'eq', value: round }],
    }],
    pattern: { version: '2', root: { kind: 'event', ref: 'ready' } },
    withinMs: 60000,
    lifecycle: { oneShot: false, cooldownMs: 0, completeOnGoal: false },
    target: { runtime: 'isolated-host', kind: 'task', id: 'turn-' + round },
  };
}
function event(round) {
  return {
    traceId: 'receipt-os-trace-' + round,
    sourceEventId: 'receipt-os-source-' + round,
    name: 'receipt.fixture.ready',
    occurredAt: new Date(Date.parse('2026-10-18T18:00:00.000Z') +
      round * 1000).toISOString(),
    serverId: 'receipt-os-fixture-provider',
    data: { round },
  };
}
function startWorker(mode, round, match, prefix, live, exits) {
  const child = fork(fixture, [], {
    env: {
      ...process.env,
      EI_RECEIPT_OS_PREFIX: prefix,
      EI_RECEIPT_OS_SCOPE: 'receipt-os-tenant',
      EI_RECEIPT_OS_TRIGGER: definition(round).triggerId,
      EI_RECEIPT_OS_MATCH: match.matchId,
      EI_RECEIPT_OS_MODE: mode,
      EI_RECEIPT_OS_WORKER: mode + '-worker-' + round,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  live.add(child);
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      live.delete(child);
      resolve({ code, signal });
    });
  });
  exits.add(exited);
  void exited.then(() => exits.delete(exited));
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() =>
      done(new Error('post-receipt SIGKILL fixture IPC timeout')), 10000);
    function done(error, message) {
      clearTimeout(timeout);
      child.off('message', messageHandler);
      child.off('error', errorHandler);
      child.off('exit', exitHandler);
      if (error) reject(error);
      else resolve(message);
    }
    function messageHandler(message) {
      if (message?.type === 'failed') {
        done(new Error('worker failed at ' + message.stage +
          ' with code ' + message.code));
      } else if (['receipt-committed', 'recovered', 'rechecked']
        .includes(message?.type)) {
        done(null, message);
      }
    }
    function errorHandler(error) {
      done(new Error('post-receipt worker error ' + error?.code));
    }
    function exitHandler(code, signal) {
      done(new Error('worker exited before IPC ' + code + '/' + signal));
    }
    child.on('message', messageHandler);
    child.once('error', errorHandler);
    child.once('exit', exitHandler);
  });
  return { child, result, exited };
}

integration('actual SIGKILL after committed EI delivery receipt before wake append and match fired recovers without host recall', {
  timeout: 90000,
}, async () => {
  const prefix = 'ei_receiptos_' + randomBytes(5).toString('hex');
  const effects = '"' + prefix + '_host_effects"';
  const scopeId = 'receipt-os-tenant';
  const pool = new Pool({ connectionString: url, max: 3 });
  const hostPool = new Pool({ connectionString: url, max: 3 });
  const live = new Set();
  const exits = new Set();
  try {
    const store = new PostgresEventStore({ pool, tablePrefix: prefix, scopeId });
    await store.init();
    await hostPool.query(
      'CREATE TABLE ' + effects +
      ' (wake_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL)',
    );
    const engine = new CompositeTriggerEngine(store);
    for (let round = 0; round < rounds; round++) {
      const trigger = definition(round);
      await engine.register(trigger);
      const result = await engine.ingest(event(round));
      const matches = result.filter(row =>
        row.triggerId === trigger.triggerId && row.matched &&
        row.match?.status === 'matched',
      );
      assert.equal(matches.length, 1);
      const match = matches[0].match;
      const victim = startWorker('commit-hold', round, match, prefix, live, exits);
      const receipt = await victim.result;
      assert.equal(receipt.type, 'receipt-committed');
      assert.equal(receipt.attemptCount, 1);
      assert.notEqual(receipt.pid, process.pid);
      assert.equal(receipt.receiptId, 'host:' + receipt.wakeId);
      // The fixture has returned from real PG completeWakeDelivery()
      // before emitting this IPC, but coordinator has not continued to
      // append the delivered history or change the matched record.
      const durable = await store.getWakeDelivery(receipt.wakeId);
      assert.equal(durable.status, 'delivered');
      assert.equal(durable.attemptCount, 1);
      assert.equal(durable.runtimeReceiptId, receipt.receiptId);
      assert.equal((await store.latestWake(receipt.wakeId)).status, 'queued');
      assert.equal((await store.listTriggerMatches(trigger.triggerId))
        .find(row => row.matchId === match.matchId).status, 'matched');
      const host = await hostPool.query(
        'SELECT receipt_id FROM ' + effects + ' WHERE wake_id=$1',
        [receipt.wakeId],
      );
      assert.equal(host.rows.length, 1);
      assert.equal(host.rows[0].receipt_id, receipt.receiptId);

      assert.equal(victim.child.kill('SIGKILL'), true);
      assert.equal((await victim.exited).signal, 'SIGKILL');
      assert.equal((await store.latestWake(receipt.wakeId)).status, 'queued');
      assert.equal((await store.listTriggerMatches(trigger.triggerId))
        .find(row => row.matchId === match.matchId).status, 'matched');

      const replacement = startWorker('recover', round, match, prefix, live, exits);
      const recovered = await replacement.result;
      assert.equal((await replacement.exited).code, 0);
      assert.equal(recovered.type, 'recovered');
      assert.equal(recovered.status, 'wake_delivered');
      assert.notEqual(recovered.pid, receipt.pid);
      assert.equal(recovered.wakeId, receipt.wakeId);
      assert.equal(recovered.receiptId, receipt.receiptId);
      assert.equal(recovered.hostCalls, 0);

      const replay = startWorker('recheck', round, match, prefix, live, exits);
      const rechecked = await replay.result;
      assert.equal((await replay.exited).code, 0);
      assert.equal(rechecked.type, 'rechecked');
      assert.equal(rechecked.status, 'already_fired');
      assert.equal(rechecked.wakeId, receipt.wakeId);
      assert.equal(rechecked.hostCalls, 0);

      const history = await pool.query(
        'SELECT COUNT(*) FILTER (WHERE payload->>\'status\'=\'queued\')::int AS queued,' +
        ' COUNT(*) FILTER (WHERE payload->>\'status\'=\'delivered\')::int AS delivered' +
        ' FROM "' + prefix + '_history"' +
        ' WHERE scope_id=$1 AND kind=$2 AND record_key=$3',
        [scopeId, 'wake', receipt.wakeId],
      );
      assert.equal(history.rows[0].queued, 1);
      assert.equal(history.rows[0].delivered, 1);
      assert.equal((await store.getWakeDelivery(receipt.wakeId)).attemptCount, 1);
      assert.equal((await hostPool.query(
        'SELECT COUNT(*)::int AS count FROM ' + effects,
      )).rows[0].count, round + 1);
      assert.equal(await store.verifyAudit(), true);
    }
  } finally {
    // Even if child reaping times out, always close the parent pools.
    // Preserve tables on uncertain child shutdown: dropping them while a
    // live child can still write is unsafe and hides the original failure.
    try {
      for (const child of live) child.kill('SIGKILL');
      let timer;
      try {
        await Promise.race([
          Promise.allSettled([...exits]),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(
              'post-receipt child not reaped; refuse unsafe cleanup',
            )), 7000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await hostPool.query('DROP TABLE IF EXISTS ' + effects);
      for (const kind of kinds) {
        await hostPool.query(
          'DROP TABLE IF EXISTS "' + prefix + '_' + kind + '" CASCADE',
        );
      }
    } finally {
      await Promise.allSettled([hostPool.end(), pool.end()]);
    }
  }
});
