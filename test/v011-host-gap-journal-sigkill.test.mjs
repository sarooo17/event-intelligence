import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
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
