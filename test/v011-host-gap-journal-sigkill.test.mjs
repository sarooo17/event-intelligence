import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { once } from 'node:events';
import { openLegacyHostGapJournal } from '../scripts/lib/v011-host-gap-journal.mjs';

test('actual SIGKILL after fsynced poll intent leaves cold host permanently fenced', {
  skip: process.platform === 'win32' ? 'SIGKILL unavailable' : false,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ei-v011-gap-sigkill-'));
  const dir = path.join(root, 'host');
  await mkdir(dir);
  const binding = {
    directory: dir, tenantId: 'host',
    sourceSnapshotSha256: 'a'.repeat(64),
    sourceIdentitySha256: 'b'.repeat(64),
  };
  const moduleUrl = pathToFileURL(fileURLToPath(
    new URL('../scripts/lib/v011-host-gap-journal.mjs', import.meta.url))).href;
  try {
    await openLegacyHostGapJournal({ ...binding, mode: 'create' });
    const source = `
      import { openLegacyHostGapJournal } from ${JSON.stringify(moduleUrl)};
      const journal = await openLegacyHostGapJournal({
        directory: process.env.EI_TEST_GAP_DIR,
        mode: 'open',
        tenantId: 'host',
        sourceSnapshotSha256: 'a'.repeat(64),
        sourceIdentitySha256: 'b'.repeat(64),
      });
      await journal.beginPoll({ cursor: 'old-stable-cursor' });
      // The durable intent fsync completed BEFORE this real OS crash.
      process.kill(process.pid, 'SIGKILL');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, EI_TEST_GAP_DIR: dir },
      timeout: 15000,
      encoding: 'utf8',
    });
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    const recovered = await openLegacyHostGapJournal({ ...binding, mode: 'open' });
    assert.equal((await recovered.status()).state, 'polling');
    await assert.rejects(recovered.assertReady(),
      e => e?.code === 'HOST_GAP_JOURNAL_NOT_READY');
    await assert.rejects(recovered.beginPoll({ cursor: 'new-cursor' }),
      e => e?.code === 'HOST_GAP_JOURNAL_NOT_READY');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const lockTestModule = new URL('../scripts/lib/v011-host-gap-journal.mjs', import.meta.url).href;
async function localJournalSandbox(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-v011-multiprocess-'));
  const binding = {directory: dir, tenantId: 'host',
    sourceSnapshotSha256: 'a'.repeat(64), sourceIdentitySha256: 'b'.repeat(64),
    authorityEpoch: 'offline-epoch'};
  try {
    const journal = await openLegacyHostGapJournal({...binding, mode: 'create'});
    await fn(binding, journal);
  } finally { await rm(dir, {recursive: true, force: true}); }
}
function startWorker(binding, body) {
  const source = `
    import { openLegacyHostGapJournal } from ${JSON.stringify(lockTestModule)};
    const journal = await openLegacyHostGapJournal({
      ...JSON.parse(process.env.EI_JOURNAL_BINDING), mode: 'open',
    });
    setInterval(() => {}, 1000); // keep worker alive until parent terminates it
    process.send({kind: 'ready'});
    process.once('message', async () => {
      try {
        ${body}
      } catch (error) {
        process.send({kind: 'result', code: error.code ?? 'unexpected'});
      }
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: {...process.env, EI_JOURNAL_BINDING: JSON.stringify(binding)},
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const messages = [];
  const waiters = [];
  child.on('message', message => {
    if (waiters.length) waiters.shift().resolve(message);
    else messages.push(message);
  });
  let failure;
  const closed = once(child, 'exit').then(([code, signal]) => {
    failure = new Error('worker exited: ' + code + '/' + signal);
    for (const waiter of waiters.splice(0)) waiter.reject(failure);
    return {code, signal};
  });
  return {
    child, closed,
    next() {
      if (messages.length) return Promise.resolve(messages.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiters.push({resolve, reject}));
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    },
  };
}

test('two real Node workers racing the same recovery journal admit exactly one poll intent', {
  skip: process.platform === 'win32' ? 'POSIX local filesystem test' : false,
  timeout: 20000,
}, async () => {
  await localJournalSandbox(async (binding, journal) => {
    const body = `
      await journal.beginPoll({cursor: 'old-cursor', initialCursor: 'old-cursor'});
      process.send({kind: 'result', code: 'admitted'});
    `;
    const workers = [startWorker(binding, body), startWorker(binding, body)];
    try {
      for (const w of workers) assert.deepEqual(await w.next(), {kind: 'ready'});
      for (const w of workers) w.child.send('race');
      const outcomes = await Promise.all(workers.map(w => w.next()));
      assert.equal(outcomes.filter(r => r.code === 'admitted').length, 1);
      assert.ok(outcomes.some(r => ['HOST_GAP_JOURNAL_TRANSITION_LOCKED',
        'HOST_GAP_JOURNAL_NOT_READY'].includes(r.code)));
      const state = await journal.status();
      assert.equal(state.state, 'polling');
      assert.equal(state.revision, 1);
      assert.equal(state.cursor, 'old-cursor');
    } finally { await Promise.all(workers.map(w => w.stop())); }
  });
});

test('SIGKILL while a worker holds the checkpoint transition lock refuses cold reopen and another writer', {
  skip: process.platform === 'win32' ? 'SIGKILL unavailable' : false,
  timeout: 20000,
}, async () => {
  await localJournalSandbox(async (binding, journal) => {
    await journal.beginPoll({cursor: 'old-cursor'});
    await journal.validated({cursor: 'new-cursor'});
    const worker = startWorker(binding, `
      await journal.confirmHostCheckpoint({
        cursor: 'new-cursor',
        checkPersistedCheckpoint: async () => {
          process.send({kind: 'locked'});
          await new Promise(() => {});
          return true;
        },
      });
      process.send({kind: 'result', code: 'unexpected'});
    `);
    try {
      assert.deepEqual(await worker.next(), {kind: 'ready'});
      worker.child.send('checkpoint');
      assert.deepEqual(await worker.next(), {kind: 'locked'});
      await assert.rejects(journal.confirmHostCheckpoint({
        cursor: 'new-cursor', checkPersistedCheckpoint: async () => true,
      }), e => e?.code === 'HOST_GAP_JOURNAL_TRANSITION_LOCKED');
      await worker.stop();
      assert.equal((await worker.closed).signal, 'SIGKILL');
      assert.ok((await readdir(binding.directory)).includes(
        'host-legacy-replay-gap-journal.json.transition-lock'));
      await assert.rejects(openLegacyHostGapJournal({...binding, mode: 'open'}),
        e => e?.code === 'HOST_GAP_JOURNAL_TRANSITION_LOCKED');
      await assert.rejects(journal.assertReady(),
        e => e?.code === 'HOST_GAP_JOURNAL_TRANSITION_LOCKED');
    } finally { await worker.stop(); }
  });
});
