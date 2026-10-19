import { parseAuditRecord } from '../../dist/src/intelligenceProtocol/index.js';
import { canonicalJson, sha256Hex } from '../../dist/src/intelligenceProtocol/canonical.js';

/**
 * Verify a bounded audit archive against a *separately trusted* predecessor
 * anchor. An unpinned hash returned from the same compromised database does
 * not prove historical authenticity, even if internal links all match.
 */
export async function verifyAuditProofWindow(proof, {
  trustedAfterSequence,
  trustedPreviousHash,
  trustedScopeId,
} = {}) {
  if (!proof || !Array.isArray(proof.records) ||
      !Number.isSafeInteger(proof.afterSequence) ||
      proof.afterSequence < -1 ||
      !Number.isSafeInteger(proof.limit) || proof.limit < 1 || proof.limit > 1000 ||
      proof.records.length > proof.limit ||
      typeof proof.scopeId !== 'string' || !proof.scopeId ||
      proof.scopeId !== trustedScopeId ||
      !Number.isSafeInteger(trustedAfterSequence) ||
      trustedAfterSequence !== proof.afterSequence ||
      (trustedPreviousHash !== null &&
        (typeof trustedPreviousHash !== 'string' || !trustedPreviousHash)) ||
      proof.previousHash !== trustedPreviousHash ||
      typeof proof.hasMore !== 'boolean' ||
      !Number.isSafeInteger(proof.endSequence)) {
    return false;
  }
  if (proof.afterSequence === -1 && trustedPreviousHash !== null) return false;
  if (proof.afterSequence >= 0 && trustedPreviousHash === null) return false;

  let previousHash = trustedPreviousHash;
  let sequence = trustedAfterSequence;
  try {
    for (const raw of proof.records) {
      const record = parseAuditRecord(raw);
      sequence++;
      if (record.sequence !== sequence ||
          record.previousHash !== previousHash) return false;
      const { hash, ...unsigned } = record;
      if (hash !== await sha256Hex(canonicalJson(unsigned))) return false;
      previousHash = hash;
    }
  } catch {
    return false;
  }
  return proof.endSequence === sequence && proof.headHash === previousHash &&
    (!proof.hasMore || proof.records.length === proof.limit);
}
