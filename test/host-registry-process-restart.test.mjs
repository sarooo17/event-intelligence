import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workerFile = fileURLToPath(
  new URL('../conformance/registry-process-worker.mjs', import.meta.url),
);
const TIMEOUT_MS = 10000;

async function processHost(dataDir) {
  const child = fork(workerFile, [], {
    execArgv: [],
    env: { ...process.env, EI_REGISTRY_PROCESS_TEST_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr = (stderr + String(chunk)).slice(-600);
  });
  const pending = new Map();
  let nextId = 0;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let exited = false;
  let exitResolve;
  const exit = new Promise(resolve => { exitResolve = resolve; });
  const onExit = error => {
    if (exited) return;
    exited = true;
    readyReject(error);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    exitResolve();
  };
  child.once('exit', (code, signal) => onExit(
    new Error('Registry test worker exited (' + (code ?? signal) + '): ' + stderr),
  ));
  child.once('error', onExit);
  child.on('message', msg => {
    if (msg?.type === 'ready') {
      if (msg.pid === child.pid) readyResolve();
      else readyReject(new Error('Registry worker PID mismatch'));
      return;
    }
    if (msg?.type !== 'reply') return;
    const item = pending.get(msg.id);
    if (!item) return;
    pending.delete(msg.id);
    clearTimeout(item.timer);
    if (msg.error) {
      const error = new Error(msg.error.message);
      error.code = msg.error.code;
      item.reject(error);
    } else item.resolve(msg.result);
  });

  let startupTimer;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        startupTimer = setTimeout(
          () => reject(new Error('Registry process startup timed out')),
          TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    if (!exited) child.kill('SIGKILL');
    await Promise.race([
      exit,
      new Promise(resolve => setTimeout(resolve, TIMEOUT_MS)),
    ]);
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
  return {
    pid: child.pid,
    call(method, args = {}) {
      if (exited || !child.connected) {
        return Promise.reject(new Error('Registry test worker unavailable'));
      }
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Registry test RPC timed out: ' + method));
          child.kill('SIGKILL');
        }, TIMEOUT_MS);
        pending.set(id, { timer, resolve, reject });
        child.send({ id, method, args }, error => {
          if (!error) return;
          const item = pending.get(id);
          if (item) {
            clearTimeout(item.timer);
            pending.delete(id);
            item.reject(error);
          }
        });
      });
    },
    async kill() {
      if (exited) return;
      child.kill('SIGKILL');
      let timeout;
      try {
        await Promise.race([
          exit,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Registry worker refused SIGKILL')),
              TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

const getTrigger = snapshot => snapshot.triggers
  .find(row => row.id === 'registry-durable-trigger');
const source = snapshot => snapshot.sources
  .find(row => row.eventName === 'registry.changed');
const persistedSource = snapshot => snapshot.storedSources
  .find(row => row.eventName === 'registry.changed');
const assertDelivered = (snapshot, wakeId) => {
  const found = snapshot.receipts.find(row => row.wakeId === wakeId);
  assert.equal(found?.status, 'delivered');
  assert.equal(found?.runtimeReceiptId, 'registry-host-receipt:' + wakeId);
};

test('hard process restarts preserve registry revocation, replay dedup and host connection ownership', {
  timeout: 90000,
}, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-registry-process-'));
  let worker;
  const pids = [];
  try {
    worker = await processHost(dataDir);
    pids.push(worker.pid);
    const attached = await worker.call('registry', {
      connected: true, session: 'first-session',
    });
    assert.ok(attached.some(row =>
      row.connectionId === 'registry-connection' && row.status === 'attached'));
    assert.deepEqual((await worker.call('create')).connections,
      ['registry-connection']);

    await worker.call('enqueue', { id: 'registry-event-1', value: 1 });
    await worker.call('poll');
    const first = await worker.call('snapshot');
    assert.equal(getTrigger(first)?.fireCount, 1);
    assert.equal(source(first)?.enabled, true);
    assert.equal(first.wakes.length, 1);
    const firstWakeId = first.wakes[0].wakeId;
    const deliveredA = await worker.call('snapshot', { wakeIds: [firstWakeId] });
    assertDelivered(deliveredA, firstWakeId);

    const detached = await worker.call('registry', { connected: false });
    assert.ok(detached.some(row =>
      row.connectionId === 'registry-connection' && row.status === 'detached'));
    const revoked = await worker.call('snapshot', { wakeIds: [firstWakeId] });
    assert.deepEqual(revoked.connections, []);
    assert.equal(source(revoked), undefined,
      'revoked source must not remain available to host discovery');
    assert.equal(persistedSource(revoked)?.enabled, false);
    assert.equal(getTrigger(revoked)?.fireCount, 1);
    assertDelivered(revoked, firstWakeId);

    // Deliberately avoid a host.close() or any in-process simulated restart.
    await worker.kill();
    worker = await processHost(dataDir);
    pids.push(worker.pid);
    const afterKill = await worker.call('snapshot', { wakeIds: [firstWakeId] });
    assert.deepEqual(afterKill.connections, []);
    assert.equal(source(afterKill), undefined);
    assert.equal(persistedSource(afterKill)?.enabled, false);
    assert.equal(getTrigger(afterKill)?.fireCount, 1);
    assert.deepEqual(afterKill.wakes, []);
    assertDelivered(afterKill, firstWakeId);

    const reconnected = await worker.call('registry', {
      connected: true, session: 'replacement-session',
    });
    assert.ok(reconnected.some(row =>
      row.connectionId === 'registry-connection' && row.status === 'attached'));
    assert.equal(source(await worker.call('snapshot'))?.enabled, true);

    // New MCP client replays an old event after reconnect: storage-side
    // occurrence identity must prevent a second fire/host wake.
    await worker.call('enqueue', { id: 'registry-event-1', value: 1 });
    await worker.call('poll');
    let replayed = await worker.call('snapshot', { wakeIds: [firstWakeId] });
    assert.equal(getTrigger(replayed)?.fireCount, 1);
    assert.equal(replayed.wakes.length, 0);
    assertDelivered(replayed, firstWakeId);

    await worker.call('enqueue', { id: 'registry-event-2', value: 2 });
    await worker.call('poll');
    const second = await worker.call('snapshot', { wakeIds: [firstWakeId] });
    assert.equal(getTrigger(second)?.fireCount, 2);
    assert.equal(second.wakes.length, 1);
    const secondWakeId = second.wakes[0].wakeId;
    assert.notEqual(secondWakeId, firstWakeId);
    assertDelivered(second, firstWakeId);

    // A second hard restart tests that the newly delivered wake is persisted
    // and the detached source is not accidentally reactivated on startup.
    await worker.call('registry', { connected: false });
    await worker.kill();
    worker = await processHost(dataDir);
    pids.push(worker.pid);
    const third = await worker.call('snapshot', {
      wakeIds: [firstWakeId, secondWakeId],
    });
    assert.deepEqual(third.connections, []);
    assert.equal(source(third), undefined);
    assert.equal(persistedSource(third)?.enabled, false);
    assert.equal(getTrigger(third)?.fireCount, 2);
    assertDelivered(third, firstWakeId);
    assertDelivered(third, secondWakeId);
    assert.deepEqual(third.wakes, []);

    // Registry does not get lifecycle authority over a manually attached
    // host connection, even if its ID collides after a physical restart.
    await worker.call('attachExplicit');
    const conflicting = await worker.call('registry', {
      connected: true, session: 'registry-attempted-takeover',
    });
    assert.ok(conflicting.some(row =>
      row.connectionId === 'registry-connection' &&
      row.code === 'EI_HOST_REGISTRY_ID_CONFLICT'));
    assert.equal((await worker.call('snapshot')).connections.length, 1);
    const noRegistry = await worker.call('registry', { connected: false });
    assert.equal(noRegistry.some(row =>
      row.connectionId === 'registry-connection' &&
      row.status === 'detached'), false);
    assert.equal((await worker.call('snapshot')).connections.length, 1);
    assert.equal(new Set(pids).size, 3, 'must use three distinct OS PIDs');
  } finally {
    try { await worker?.kill(); } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});
