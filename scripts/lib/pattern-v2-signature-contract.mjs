import { open, readFile, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// This is NOT the Pattern AST wire version (which remains 2) or the
// PostgreSQL physical schema version (which remains 1).
export const PATTERN_V2_SIGNATURE_CONTRACT_VERSION = 2;
export const PATTERN_V2_SIGNATURE_COMPONENT = 'pattern_v2_candidate_signature';
export const PATTERN_V2_SIGNATURE_FILE = 'pattern-v2-signature-contract.json';

export function patternV2SignatureError(reason) {
  const error = new Error(
    'Persisted Pattern v2 candidate/signature identity is incompatible: ' +
    reason + '. Stop all workers, take a verified backup and follow the ' +
    'explicit operator reset/replay procedure; no state was reset.',
  );
  error.code = 'EVENT_INTELLIGENCE_PATTERN_V2_SIGNATURE_INCOMPATIBLE';
  return error;
}

/**
 * Scope-local, exclusive-create marker for the single-process JSONL backend.
 * Existing Pattern v2 state with no marker is ambiguous: old signatures and
 * pending condition/deadline IDs cannot be safely reinterpreted. Never
 * silently "adopt" it. A genuinely empty store can be marked atomically.
 */
export async function assertJsonlPatternV2SignatureContract(dataDir, hasLegacyPatternState) {
  const file = path.join(dataDir, PATTERN_V2_SIGNATURE_FILE);
  const verify = async () => {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      throw patternV2SignatureError('malformed JSONL signature manifest');
    }
    if (manifest?.component !== PATTERN_V2_SIGNATURE_COMPONENT ||
        manifest.version !== PATTERN_V2_SIGNATURE_CONTRACT_VERSION) {
      throw patternV2SignatureError('unknown or mismatched JSONL signature manifest');
    }
    return true;
  };

  if (await verify()) return;
  if (hasLegacyPatternState) {
    throw patternV2SignatureError('unmarked pre-existing Pattern v2 state');
  }

  // A direct open(file, 'wx') exposes a zero-byte file while writeFile is
  // pending. Even two concurrent in-process forScope() constructors could
  // misread it as an invalid manifest. Create/sync a unique temporary file,
  // then publish its *complete contents* using an atomic hard link. link()
  // fails with EEXIST instead of overwriting another writer's decision.
  const temporary = path.join(
    dataDir, '.' + PATTERN_V2_SIGNATURE_FILE + '.' + randomUUID() + '.tmp',
  );
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({
          component: PATTERN_V2_SIGNATURE_COMPONENT,
          version: PATTERN_V2_SIGNATURE_CONTRACT_VERSION,
        }) + '\n',
        'utf8',
      );
      await handle.sync();
    } finally {
      await handle.close();
      handle = undefined;
    }
    try {
      await link(temporary, file);
    } catch (error) {
      if (error?.code !== 'EEXIST' || !await verify()) throw error;
    }
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}
