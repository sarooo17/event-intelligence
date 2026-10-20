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
const fixture = new URL('./fixtures/postgres-provider-pre-ingest-worker.mjs', import.meta.url);
const rounds = 3;
const scopeId = 'pre-ingest-tenant';
const eventName = 'fixture.issue.changed';
const source = {
  connectionId: 'provider-before-ingest-connection',
  serverId: 'isolated-provider-fixture',
  eventName,
  arguments: { repository: 'example/evidence' },
  deliveryMode: 'poll',
};
const cleanupKinds = ['metadata', 'leases', 'history', 'records', 'counters'];

function definition() {
  return {
    triggerId: 'source-pre-ingest-replay',
    version: '1',
    clauses: [{
      id: 'changed', event: eventName,
      serverId: source.serverId, arguments: source.arguments,
      where: [{ path: 'repository', op: 'eq', value: 'example/evidence' }],
    }],
    pattern: { version: '2', root: { kind: 'event', ref: 'changed' } },
    withinMs: 60000,
    lifecycle: { oneShot: false, cooldownMs: 0, completeOnGoal: false },
    target: { runtime: 'host-fixture', kind: 'task', id: 'turn-issue' },
  };
}

function startWorker(extra, prefix, children, childExits) {
  const child = fork(fixture, [], {
    env: {
      ...process.env,
      EI_SOURCE_PREFIX: prefix,
      EI_SOURCE_SCOPE: scopeId,
      ...extra,
    },
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
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error('source worker did not send IPC checkpoint')),
      12000,
    );
    function finish(error, message) {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(message);
    }
    function onMessage(message) {
      if (message?.type === 'failed') {
        finish(new Error('source worker failed at ' + message.stage +
          ' with code ' + message.code));
      } else if (['provider-event-received', 'recovered', 'replayed']
        .includes(message?.type)) {
        finish(null, message);
      }
    }
    function onError(error) {
      finish(new Error('source worker process error ' + error?.code));
    }
    function onExit(code, signal) {
      finish(new Error('source worker exited before IPC ' + code +
        '/' + signal));
    }
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  return { child, exited, result };
}

integration('real SIGKILL before EI event persistence replays from durable provider without losing matches or duplicating wakes', {
  timeout: 90000,
}, async () => {
  const prefix = 'ei_sourcekill_' + randomBytes(5).toString('hex');
  const outbox = '"' + prefix + '_provider_outbox"';
  const effects = '"' + prefix + '_host_effects"';
  const attempts = '"' + prefix + '_host_attempts"';
  const storePool = new Pool({ connectionString: url, max: 3 });
  const hostPool = new Pool({ connectionString: url, max: 3 });
  const children = new Set();
  const childExits = new Set();
  const recoveredWakes = new Set();
  try {
    const store = new PostgresEventStore({
      pool: storePool, dispatchPoolIdentity: storePool, scopeId, tablePrefix: prefix,
    });
    await store.init();
    await new CompositeTriggerEngine(store).register(definition());
    await store.putMcpClientState({
      ...source, cursor: 'cursor:0', truncated: false,
    });
    // The outbox is an independent upstream provider fixture. EI has no
    // ownership of its event retention, acknowledgment, or replay policy.
    await hostPool.query(
      'CREATE TABLE ' + outbox + ' (' +
      'sequence BIGINT PRIMARY KEY, event JSONB NOT NULL, ' +
      'acked BOOLEAN NOT NULL DEFAULT FALSE)',
    );
    await hostPool.query(
      'CREATE TABLE ' + effects +
      ' (wake_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL)',
    );
    await hostPool.query(
      'CREATE TABLE ' + attempts +
      ' (id BIGSERIAL PRIMARY KEY, wake_id TEXT NOT NULL, worker_id TEXT NOT NULL)',
    );

    for (let sequence = 1; sequence <= rounds; sequence++) {
      const event = {
        eventId: 'provider-occurrence-' + sequence,
        name: eventName,
        timestamp: new Date(Date.parse('2026-10-18T16:00:00.000Z') +
          sequence * 1000).toISOString(),
        data: { repository: 'example/evidence', revision: sequence },
      };
      await hostPool.query(
        'INSERT INTO ' + outbox + ' (sequence, event) VALUES ($1, $2::jsonb)',
        [sequence, JSON.stringify(event)],
      );
      const beforeCursor = await store.getMcpClientState(
        source.connectionId, eventName, source.arguments,
      );
      const beforeMatches = await store.listTriggerMatches(definition().triggerId);
      assert.equal(beforeCursor.cursor, 'cursor:' + (sequence - 1));

      const common = {
        EI_SOURCE_SEQUENCE: String(sequence),
        EI_SOURCE_WORKER: 'source-worker-' + sequence,
      };
      const victim = startWorker({
        ...common, EI_SOURCE_MODE: 'hold-before-ingest',
      }, prefix, children, childExits);
      const observed = await victim.result;
      assert.equal(observed.type, 'provider-event-received');
      assert.equal(observed.eventId, event.eventId);
      assert.notEqual(observed.pid, process.pid);
      // Precise boundary: event is present at provider and the victim has
      // received it, but EI has not persisted a match or advanced a cursor.
      assert.deepEqual(
        await store.listTriggerMatches(definition().triggerId), beforeMatches,
        'receiving the provider event did not durably mutate EI matches',
      );
      assert.equal((await hostPool.query(
        'SELECT acked FROM ' + outbox + ' WHERE sequence=$1',
        [sequence],
      )).rows[0].acked, false);
      assert.equal((await store.getMcpClientState(
        source.connectionId, eventName, source.arguments,
      )).cursor, beforeCursor.cursor);

      assert.equal(victim.child.kill('SIGKILL'), true);
      const dead = await victim.exited;
      assert.equal(dead.signal, 'SIGKILL',
        'this must be a real OS process kill, not a pool disconnect');
      assert.deepEqual(
        await store.listTriggerMatches(definition().triggerId), beforeMatches,
        'OS kill occurred before any EI match persistence',
      );
      const replacement = startWorker({
        ...common, EI_SOURCE_MODE: 'recover',
        EI_SOURCE_WORKER: 'replacement-' + sequence,
      }, prefix, children, childExits);
      const recovered = await replacement.result;
      assert.equal((await replacement.exited).code, 0);
      assert.equal(recovered.type, 'recovered');
      assert.notEqual(recovered.pid, observed.pid);
      assert.equal(recovered.eventId, event.eventId);
      assert.equal(recovered.status, 'wake_delivered');
      assert.equal(recovered.hostCalls, 1);
      assert.equal(recoveredWakes.has(recovered.wakeId), false);
      recoveredWakes.add(recovered.wakeId);
      assert.equal((await store.getMcpClientState(
        source.connectionId, eventName, source.arguments,
      )).cursor, 'cursor:' + sequence);
      assert.equal((await hostPool.query(
        'SELECT acked FROM ' + outbox + ' WHERE sequence=$1',
        [sequence],
      )).rows[0].acked, true);
      const saved = (await store.listTriggerMatches(definition().triggerId));
      // Pattern v2 persists partial/open candidate state as well.
      assert.equal(saved.filter(row => row.status === 'fired').length, sequence);

      // Explicitly replay the SAME event and source identity again, even
      // though the provider has acknowledged it. No second host callback.
      const duplicate = startWorker({
        ...common, EI_SOURCE_MODE: 'force-replay',
        EI_SOURCE_WORKER: 'duplicate-' + sequence,
      }, prefix, children, childExits);
      const replayed = await duplicate.result;
      assert.equal((await duplicate.exited).code, 0);
      assert.equal(replayed.type, 'replayed');
      assert.equal(replayed.status, 'already_fired');
      assert.equal(replayed.wakeId, recovered.wakeId);
      assert.equal(replayed.receiptId, recovered.receiptId);
      assert.equal(replayed.hostCalls, 0);
      assert.equal((await store.listTriggerMatches(definition().triggerId))
        .filter(row => row.status === 'fired').length, sequence,
        'forced replay must not create a second fired logical match');
      assert.equal((await hostPool.query(
        'SELECT COUNT(*)::int AS count FROM ' + attempts,
      )).rows[0].count, sequence);
      assert.equal((await hostPool.query(
        'SELECT COUNT(*)::int AS count FROM ' + effects,
      )).rows[0].count, sequence);
    }

    assert.equal(recoveredWakes.size, rounds);
    assert.equal((await hostPool.query(
      'SELECT COUNT(*)::int AS count FROM ' + outbox +
      ' WHERE acked=true',
    )).rows[0].count, rounds);
    const finalStore = new PostgresEventStore({
      pool: new Pool({ connectionString: url, max: 2 }),
      scopeId, tablePrefix: prefix,
    });
    try {
      await finalStore.init();
      assert.equal((await finalStore.listTriggerMatches(definition().triggerId))
        .filter(row => row.status === 'fired').length, rounds);
      assert.equal(await finalStore.verifyAudit(), true);
    } finally {
      await finalStore.pool.end();
    }
  } finally {
    for (const child of children) child.kill('SIGKILL');
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([...childExits]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            'provider child processes not reaped: refuse unsafe table cleanup',
          )), 7000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    try {
      for (const table of [attempts, effects, outbox]) {
        await hostPool.query('DROP TABLE IF EXISTS ' + table);
      }
      for (const kind of cleanupKinds) {
        await hostPool.query(
          'DROP TABLE IF EXISTS "' + prefix + '_' + kind + '" CASCADE',
        );
      }
    } finally {
      await Promise.allSettled([hostPool.end(), storePool.end()]);
    }
  }
});
