import { parseAuditRecord } from '../../dist/src/intelligenceProtocol/index.js';
import { canonicalJson, sha256Hex } from '../../dist/src/intelligenceProtocol/canonical.js';

/**
 * Independent verification requires a trusted snapshot committed out of
 * band. It must bind the scope, first record, final sequence and final hash.
 * An unpinned database-provided checkpoint is never a trust root.
 */
export async function verifyAuditProofWindow(proof, {
  trustedCheckpoint,
  trustedAfterSequence,
  trustedPreviousHash,
  trustedLimit,
} = {}) {
  const checkpoint = trustedCheckpoint;
  if (!checkpoint || !proof || !Array.isArray(proof.records) ||
      typeof checkpoint.scopeId !== 'string' || !checkpoint.scopeId ||
      !Number.isSafeInteger(checkpoint.endSequence) ||
      checkpoint.endSequence < -1 ||
      !Number.isSafeInteger(trustedAfterSequence) ||
      trustedAfterSequence < -1 ||
      trustedAfterSequence > checkpoint.endSequence ||
      !Number.isSafeInteger(trustedLimit) ||
      trustedLimit < 1 || trustedLimit > 1000 ||
      proof.limit !== trustedLimit ||
      proof.records.length > trustedLimit ||
      proof.scopeId !== checkpoint.scopeId ||
      proof.afterSequence !== trustedAfterSequence ||
      proof.previousHash !== trustedPreviousHash ||
      !Number.isSafeInteger(proof.endSequence) ||
      typeof proof.hasMore !== 'boolean' ||
      (checkpoint.endSequence === -1 &&
        (checkpoint.firstHash !== null || checkpoint.headHash !== null)) ||
      (checkpoint.endSequence >= 0 &&
        (typeof checkpoint.firstHash !== 'string' || !checkpoint.firstHash ||
          typeof checkpoint.headHash !== 'string' || !checkpoint.headHash)) ||
      (trustedAfterSequence === -1 && trustedPreviousHash !== null) ||
      (trustedAfterSequence >= 0 &&
        (typeof trustedPreviousHash !== 'string' || !trustedPreviousHash))) {
    return false;
  }
  let sequence = trustedAfterSequence;
  let hash = trustedPreviousHash;
  try {
    for (const row of proof.records) {
      const record = parseAuditRecord(row);
      sequence += 1;
      if (record.sequence !== sequence || record.previousHash !== hash) {
        return false;
      }
      const { hash: actual, ...unsigned } = record;
      if (actual !== await sha256Hex(canonicalJson(unsigned))) return false;
      if (sequence === 0 && actual !== checkpoint.firstHash) return false;
      hash = actual;
    }
  } catch {
    return false;
  }
  if (sequence !== proof.endSequence || hash !== proof.headHash ||
      sequence > checkpoint.endSequence) return false;
  const moreExpected = sequence < checkpoint.endSequence;
  return proof.hasMore === moreExpected &&
    (moreExpected
      ? proof.records.length === trustedLimit
      : sequence === checkpoint.endSequence && hash === checkpoint.headHash);
}
