import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { openLegacyHostGapJournal } from '../scripts/lib/v011-host-gap-journal.mjs';

const HASH_OLD = 'a'.repeat(64);
const HASH_SOURCE = 'b'.repeat(64);
const bind = { sourceSnapshotSha256: HASH_OLD, sourceIdentitySha256: HASH_SOURCE, tenantId: 'host' };
const code = value => err => err?.code === value;
async function sandbox(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-v011-gap-journal-'));
  const folder = path.join(dir, 'host-owned');
  await mkdir(folder);
  const create = options => openLegacyHostGapJournal({ directory: folder, ...bind, mode: 'create', ...options });
  const reopen = options => openLegacyHostGapJournal({ directory: folder, ...bind, mode: 'open', ...options });
  try { await fn({ dir, folder, create, reopen }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('journal is fsync durable, requires host checkpoint proof and refuses unacknowledged restart', async () => {
  await sandbox(async ({ create, reopen }) => {
    const original = await create();
    assert.equal((await original.status()).state, 'ready');
    await original.beginPoll({ cursor: 'old-source-cursor' });
    assert.equal((await original.status()).state, 'polling');
    const coldDuringRpc = await reopen();
    await assert.rejects(coldDuringRpc.assertReady(), code('HOST_GAP_JOURNAL_NOT_READY'));

    await original.validated({ cursor: 'new-provider-cursor' });
    assert.equal((await original.status()).state, 'checkpoint-required');
    const coldAfterPage = await reopen();
    await assert.rejects(coldAfterPage.assertReady(), code('HOST_GAP_JOURNAL_NOT_READY'));
    await assert.rejects(coldAfterPage.confirmHostCheckpoint({
      cursor: 'new-provider-cursor', checkPersistedCheckpoint: async () => false,
    }), code('HOST_CHECKPOINT_NOT_DURABLE'));
    await assert.rejects(coldAfterPage.confirmHostCheckpoint({
      cursor: 'wrong-checkpoint', checkPersistedCheckpoint: async () => true,
    }), code('HOST_GAP_JOURNAL_CHECKPOINT_MISMATCH'));

    let verified = 0;
    await coldAfterPage.confirmHostCheckpoint({
      cursor: 'new-provider-cursor',
      checkPersistedCheckpoint: async cursor => { verified++; return cursor === 'new-provider-cursor'; },
    });
    assert.equal(verified, 1);
    const reopened = await reopen();
    await reopened.assertReady();
    assert.equal((await reopened.status()).cursor, 'new-provider-cursor');
    assert.equal((await reopened.status()).revision, 3);
  });
});

test('a damaged or missing durable journal refuses instead of initializing a new permit', async () => {
  await sandbox(async ({ folder, create, reopen }) => {
    await assert.rejects(reopen(), code('HOST_GAP_JOURNAL_MISSING'));
    const journal = await create();
    await assert.rejects(create(), code('HOST_GAP_JOURNAL_ALREADY_EXISTS'));
    await assert.rejects(reopen({ sourceIdentitySha256: 'c'.repeat(64) }),
      code('HOST_GAP_JOURNAL_INVALID_OR_MISMATCHED'));
    await assert.rejects(reopen({ tenantId: 'unrelated-tenant' }),
      code('HOST_GAP_JOURNAL_INVALID_OR_MISMATCHED'));
    await journal.beginPoll({ cursor: 'before-damage' });
    await writeFile(path.join(folder, 'host-legacy-replay-gap-journal.json'), '{');
    await assert.rejects(reopen(), code('HOST_GAP_JOURNAL_INVALID_OR_MISMATCHED'));
  });
});

test('failed poll block is irreversible and survives cold-reopened host state', async () => {
  await sandbox(async ({ create, reopen }) => {
    const original = await create();
    await original.beginPoll({ cursor: 'old-cursor' });
    await original.block();
    const cold = await reopen();
    assert.equal((await cold.status()).state, 'blocked');
    await assert.rejects(cold.assertReady(), code('HOST_GAP_JOURNAL_NOT_READY'));
    await assert.rejects(cold.confirmHostCheckpoint({
      cursor: 'old-cursor', checkPersistedCheckpoint: async () => true,
    }), code('HOST_GAP_JOURNAL_CHECKPOINT_MISMATCH'));
    await assert.rejects(cold.beginPoll({ cursor: 'new-cursor' }),
      code('HOST_GAP_JOURNAL_NOT_READY'));
    await assert.rejects(create(), code('HOST_GAP_JOURNAL_ALREADY_EXISTS'));
  });
});

test('a partial atomic replacement file fails closed on restart', async () => {
  await sandbox(async ({ folder, create, reopen }) => {
    const journal = await create();
    await writeFile(path.join(folder, 'host-legacy-replay-gap-journal.json.pending-crash'), 'incomplete');
    await assert.rejects(reopen(), code('HOST_GAP_JOURNAL_INTERRUPTED_WRITE'));
    await assert.rejects(journal.assertReady(), code('HOST_GAP_JOURNAL_INTERRUPTED_WRITE'));
  });
});

test('parallel same-handle transitions are serialized and cannot each start a poll', async () => {
  await sandbox(async ({ create }) => {
    const journal = await create();
    const results = await Promise.allSettled([
      journal.beginPoll({ cursor: 'one' }),
      journal.beginPoll({ cursor: 'two' }),
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.filter(x => x.status === 'rejected').length, 1);
    assert.equal((await journal.status()).state, 'polling');
  });
});

test('all journal files are private regular files', async () => {
  await sandbox(async ({ folder, create }) => {
    const journal = await create();
    await journal.beginPoll({ cursor: 'old' });
    const names = await readdir(folder);
    assert.deepEqual(names, ['host-legacy-replay-gap-journal.json']);
    const data = JSON.parse(await readFile(path.join(folder, names[0]), 'utf8'));
    assert.equal(data.sourceSnapshotSha256, HASH_OLD);
    assert.equal(data.sourceIdentitySha256, HASH_SOURCE);
    assert.equal(data.state, 'polling');
    assert.equal(data.schema, 'ei-host-legacy-replay-gap-journal.v1');
  });
});
