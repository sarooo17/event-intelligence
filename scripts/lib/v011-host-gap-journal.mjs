import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { LegacyJsonlPreflightError } from './v011-jsonl-upgrade-preflight.mjs';

// Host-owned recovery journal. A conservative, one-writer, OFFLINE
// prerequisite; never store it inside the legacy v0.11 EI JSONL source.
// A journal is not a host-side transition authorization or proof of provider
// completeness. Real host control must separately fence all old/new workers.
const refuse = code => { throw new LegacyJsonlPreflightError(code); };
const SCHEMA = 'ei-host-legacy-replay-gap-journal.v1';
const FILE = 'host-legacy-replay-gap-journal.json';
const LOCK = FILE + '.transition-lock';
const validHash = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const validCursor = v => typeof v === 'string' && v.length > 0 && v.length <= 4096;

async function syncDirectory(dir) {
  const handle = await open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function assertNoTransitionLock(dir) {
  try { await lstat(path.join(dir, LOCK)); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  refuse('HOST_GAP_JOURNAL_TRANSITION_LOCKED');
}

// Local filesystem only: exclusive create is the cross-process transition
// linearization point. Never steal or expire a lock, including after a crash.
// An I/O failure leaves the lock in place for explicit offline disposition.
// The host still owns full-session authority and downstream effect fencing.
async function withTransitionLock(dir, fn) {
  const filename = path.join(dir, LOCK);
  let handle;
  try { handle = await open(filename, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') refuse('HOST_GAP_JOURNAL_TRANSITION_LOCKED');
    throw error;
  }
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dir);
  let result;
  let refusal;
  try { result = await fn(); }
  catch (error) {
    // Expected state/precondition refusals may release the lock. Unexpected
    // errors (including failed durability writes) must retain it.
    if (!(error instanceof LegacyJsonlPreflightError)) throw error;
    refusal = error;
  }
  await unlink(filename);
  await syncDirectory(dir);
  if (refusal) throw refusal;
  return result;
}

async function assertNoPartialFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some(x => x.name.startsWith(FILE + '.pending-'))) {
    refuse('HOST_GAP_JOURNAL_INTERRUPTED_WRITE');
  }
}

function validateRecord(record, expected) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      record.schema !== SCHEMA ||
      record.sourceSnapshotSha256 !== expected.sourceSnapshotSha256 ||
      record.sourceIdentitySha256 !== expected.sourceIdentitySha256 ||
      record.tenantId !== expected.tenantId ||
      record.authorityEpoch !== expected.authorityEpoch ||
      !['ready', 'polling', 'checkpoint-required', 'blocked'].includes(record.state) ||
      !Number.isSafeInteger(record.revision) || record.revision < 0 ||
      (record.state === 'ready' && (record.revision === 0
        ? record.cursor !== null : !validCursor(record.cursor))) ||
      (record.state === 'checkpoint-required' && !validCursor(record.cursor)) ||
      (record.state === 'polling' && !validCursor(record.cursor))) {
    refuse('HOST_GAP_JOURNAL_INVALID_OR_MISMATCHED');
  }
  return record;
}

async function readRecord(dir, expected) {
  await assertNoPartialFiles(dir);
  const file = path.join(dir, FILE);
  let stat;
  try { stat = await lstat(file); }
  catch (error) {
    if (error?.code === 'ENOENT') refuse('HOST_GAP_JOURNAL_MISSING');
    throw error;
  }
  if (!stat.isFile() || stat.size > 12000) refuse('HOST_GAP_JOURNAL_INVALID_OR_MISMATCHED');
  let record;
  try { record = JSON.parse(await readFile(file, 'utf8')); }
  catch { refuse('HOST_GAP_JOURNAL_INVALID_OR_MISMATCHED'); }
  return validateRecord(record, expected);
}

async function durableReplace(dir, state, { exclusive = false } = {}) {
  const filename = path.join(dir, FILE);
  const text = JSON.stringify(state) + '\n';
  if (Buffer.byteLength(text) > 12000) refuse('HOST_GAP_JOURNAL_INVALID_OR_MISMATCHED');
  if (exclusive) {
    const handle = await open(filename, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
  } else {
    const tmp = path.join(dir, FILE + '.pending-' + randomUUID());
    const handle = await open(tmp, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    await rename(tmp, filename);
  }
  // A successful transition is acknowledged only after file + dir fsync.
  await syncDirectory(dir);
}

/**
 * mode=create MUST be a one-time, separately authorized rehearsal.
 * mode=open never initializes a missing journal. A crash during a poll,
 * incomplete checkpoint confirmation, lost file, or stale pending temp file
 * MUST stay fail-closed, not reset to 'ready' on restart.
 *
 * Local exclusive transitions, still one authorized recovery writer only.
 * This does NOT provide a multiworker distributed lock,
 * source-epoch fencing or production deploy authorization.
 */
export async function openLegacyHostGapJournal({
  directory, mode, sourceSnapshotSha256, sourceIdentitySha256, tenantId,
  authorityEpoch = null,
} = {}) {
  if (typeof directory !== 'string' || !directory ||
      !['create', 'open'].includes(mode) ||
      !validHash(sourceSnapshotSha256) || !validHash(sourceIdentitySha256) ||
      typeof tenantId !== 'string' || !tenantId || tenantId.length > 240 ||
      (authorityEpoch !== null &&
        (typeof authorityEpoch !== 'string' || !authorityEpoch ||
          authorityEpoch.length > 240 || authorityEpoch !== authorityEpoch.trim()))) {
    refuse('HOST_GAP_JOURNAL_EXPLICIT_BINDING_REQUIRED');
  }
  const dir = await realpath(directory); // already-created isolated host path
  const stat = await lstat(dir);
  if (!stat.isDirectory()) refuse('HOST_GAP_JOURNAL_DIRECTORY_INVALID');
  const expected = { sourceSnapshotSha256, sourceIdentitySha256, tenantId, authorityEpoch };
  if (mode === 'create') {
    await withTransitionLock(dir, async () => {
      await assertNoPartialFiles(dir);
      const existing = await readdir(dir);
      if (existing.includes(FILE)) refuse('HOST_GAP_JOURNAL_ALREADY_EXISTS');
      await durableReplace(dir, {
        schema: SCHEMA, ...expected, state: 'ready', cursor: null, revision: 0,
      }, { exclusive: true });
    });
  } else {
    await assertNoTransitionLock(dir);
    await readRecord(dir, expected);
  }
  let queue = Promise.resolve();
  // Serialize within the handle and exclude other local processes across
  // the entire read/validate/replace transaction. This is NOT a distributed
  // lease, and cannot authorize another worker to adopt a running poll.
  const update = fn => {
    const task = queue.then(() => withTransitionLock(dir, async () => {
      const current = await readRecord(dir, expected);
      const next = await fn(current);
      if (!next) return current;
      const replacement = {
        ...current, ...next, revision: current.revision + 1,
      };
      await durableReplace(dir, replacement);
      return replacement;
    }));
    queue = task.catch(() => {});
    return task;
  };
  const assertReady = () => update(current => {
    if (current.state !== 'ready') refuse('HOST_GAP_JOURNAL_NOT_READY');
    return null;
  });
  return Object.freeze({
    sourceSnapshotSha256,
    sourceIdentitySha256,
    tenantId,
    authorityEpoch,
    assertReady,
    async beginPoll({ cursor, initialCursor }) {
      if (!validCursor(cursor) ||
          (initialCursor !== undefined && !validCursor(initialCursor))) {
        refuse('HOST_GAP_JOURNAL_INVALID_POLL_CURSOR');
      }
      return update(current => {
        if (current.state !== 'ready') refuse('HOST_GAP_JOURNAL_NOT_READY');
        // Opaque cursors cannot be ordered. Require exact equality with the
        // last confirmed checkpoint, or the independently attested old
        // cursor on first use. No reset/skip on cold reopen.
        const expected = current.cursor ?? initialCursor;
        if (expected !== undefined && cursor !== expected) {
          refuse('HOST_GAP_JOURNAL_POLL_CURSOR_MISMATCH');
        }
        return { state: 'polling', cursor };
      });
    },
    async validated({ cursor }) {
      if (!validCursor(cursor)) refuse('HOST_GAP_JOURNAL_INVALID_POLL_CURSOR');
      return update(current => {
        if (current.state !== 'polling') refuse('HOST_GAP_JOURNAL_NOT_POLLING');
        // Explicit host checkpoint readback is REQUIRED before any next poll.
        return { state: 'checkpoint-required', cursor };
      });
    },
    async confirmHostCheckpoint({ cursor, checkPersistedCheckpoint }) {
      if (!validCursor(cursor) || typeof checkPersistedCheckpoint !== 'function') {
        refuse('HOST_CHECKPOINT_READER_REQUIRED');
      }
      return update(async current => {
        if (current.state !== 'checkpoint-required' || current.cursor !== cursor) {
          refuse('HOST_GAP_JOURNAL_CHECKPOINT_MISMATCH');
        }
        const proof = await checkPersistedCheckpoint(cursor);
        if (proof !== true) refuse('HOST_CHECKPOINT_NOT_DURABLE');
        return { state: 'ready', cursor };
      });
    },
    async block() {
      return update(current => current.state === 'blocked'
        ? null : { state: 'blocked', cursor: null });
    },
    async status() {
      await assertNoTransitionLock(dir);
      return readRecord(dir, expected);
    },
  });
}
