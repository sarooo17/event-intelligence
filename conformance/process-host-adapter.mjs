// Local black-box, *separate OS-process* reference-host adapter for
// runHostConformance v3. The parent never imports the EI runtime.
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const workerFile = fileURLToPath(new URL('./process-host-worker.mjs', import.meta.url));
const READY_TIMEOUT_MS = 15000;
const RPC_TIMEOUT_MS = 15000;
const EXIT_TIMEOUT_MS = 5000;

async function startWorker(dataDir, observability, onSpawn) {
  const child = fork(workerFile, [], {
    execArgv: [],
    env: { ...process.env, EI_CONFORMANCE_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr = (stderr + String(chunk)).slice(-1500);
  });
  const pending = new Map();
  let sequence = 0;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let finished = false;
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      finished = true;
      const error = new Error('EI conformance child exited: ' +
        String(code ?? signal) + ' ' + stderr.slice(-400));
      readyReject(error);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
      resolve({ code, signal });
    });
  });
  child.on('error', error => readyReject(error));
  child.on('message', message => {
    if (message?.type === 'observation' && typeof message.event === 'string') {
      observability({ event: message.event });
      return;
    }
    if (message?.type === 'ready') {
      if (message.pid !== child.pid) {
        readyReject(new Error('Invalid worker process identity'));
        return;
      }
      readyResolve();
      return;
    }
    if (message?.type !== 'reply') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  });
  const startupTimer = setTimeout(
    () => readyReject(new Error('Host conformance worker startup timed out')),
    READY_TIMEOUT_MS,
  );
  try {
    await ready;
    onSpawn?.(child.pid);
  } catch (error) {
    if (!finished) child.kill('SIGKILL');
    await exited;
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }

  return {
    pid: child.pid,
    call(method, ...args) {
      if (finished || !child.connected) {
        return Promise.reject(new Error('Conformance worker unavailable'));
      }
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Conformance worker RPC timed out: ' + method));
        }, RPC_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, method, args }, error => {
          if (!error) return;
          const item = pending.get(id);
          if (item) {
            pending.delete(id);
            clearTimeout(item.timer);
            item.reject(error);
          }
        });
      });
    },
    async terminate(signal = 'SIGKILL') {
      if (finished) return;
      child.kill(signal);
      await Promise.race([
        exited,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('Host conformance worker did not exit')),
          EXIT_TIMEOUT_MS,
        )),
      ]);
    },
  };
}

export function createProcessHostAdapter({
  onSpawn,
  suppressRestoredReceipt = false,
} = {}) {
  return {
    name: 'separate-os-process-reference-host',
    async createHarness({ observability }) {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-process-conformance-'));
      let worker;
      try {
        worker = await startWorker(dataDir, observability, onSpawn);
      } catch (error) {
        await rm(dataDir, { recursive: true, force: true });
        throw error;
      }
      let deliveredOffset = 0;
      const externallyObservedDeliveries = [];
      let restartCount = 0;
      const call = (name, ...args) => worker.call(name, ...args);
      return {
        createTrigger: input => call('createTrigger', input),
        emitEvent: input => call('emitEvent', input),
        inspectTrigger: id => call('inspectTrigger', id),
        listTriggers: () => call('listTriggers'),
        pauseTrigger: id => call('pauseTrigger', id),
        resumeTrigger: id => call('resumeTrigger', id),
        updateTrigger: input => call('updateTrigger', input),
        deleteTrigger: id => call('deleteTrigger', id),
        async deliveries() {
          // Parent-side observer survives the subprocess and may retain
          // external callbacks, but NEVER supplies durable wake receipts.
          const current = await call('deliveries');
          if (!Array.isArray(current) || current.length < deliveredOffset) {
            throw new Error('Worker external delivery observation regressed');
          }
          externallyObservedDeliveries.push(...current.slice(deliveredOffset));
          deliveredOffset = current.length;
          return [...externallyObservedDeliveries];
        },
        async readWakeReceipt(id) {
          if (suppressRestoredReceipt && restartCount > 0) return null;
          return call('readWakeReceipt', id);
        },
        async restart() {
          // Kill the entire process, without calling EI close(). Durable
          // state is reopened by a fresh instance with a *different PID*.
          await worker.terminate('SIGKILL');
          worker = await startWorker(dataDir, observability, onSpawn);
          deliveredOffset = 0;
          restartCount += 1;
        },
        async close() {
          try {
            await call('close');
          } finally {
            try {
              await worker.terminate('SIGKILL');
            } finally {
              await rm(dataDir, { recursive: true, force: true });
            }
          }
        },
      };
    },
  };
}
