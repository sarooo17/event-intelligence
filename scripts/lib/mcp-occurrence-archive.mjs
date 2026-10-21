import { createHash } from 'node:crypto';

const SCHEMA = 'event-intelligence.mcp-occurrence-archive.v1';
const HASH = /^[0-9a-f]{64}$/;
const safeInteger = n => Number.isSafeInteger(n) && n >= 0;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  }
  return value;
}
function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function mcpArchiveGenesis(scopeId) {
  if (typeof scopeId !== 'string' || !scopeId) {
    throw new TypeError('Archive scopeId must be nonempty');
  }
  return digest({ schema: SCHEMA, scopeId, kind: 'genesis' });
}
export function mcpArchiveRecordHash(scopeId, previousHash, record) {
  if (typeof scopeId !== 'string' || !scopeId || !HASH.test(previousHash) ||
      !record || !Number.isSafeInteger(record.sequence) || record.sequence < 1 ||
      typeof record.serverId !== 'string' || !record.serverId ||
      !(record.subscriptionId === null || typeof record.subscriptionId === 'string') ||
      typeof record.event?.eventId !== 'string' || !record.event.eventId) {
    throw new TypeError('Invalid MCP archive scope, hash or occurrence record');
  }
  return digest({ schema: SCHEMA, scopeId, previousHash, record });
}

/**
 * Independently verify one bounded window with a separately pinned checkpoint
 * and a previous hash independently validated from the preceding page.
 * A DB-generated checkpoint MUST NOT itself be treated as a trusted anchor.
 */
export function verifyMcpOccurrenceArchiveWindow(proof, {
  trustedCheckpoint, trustedAfterSequence, trustedPreviousHash, trustedLimit,
} = {}) {
  const cp = trustedCheckpoint;
  if (!cp || cp.schema !== SCHEMA || !safeInteger(cp.endSequence) ||
      typeof cp.scopeId !== 'string' || !cp.scopeId ||
      !HASH.test(cp.genesisHash) || !HASH.test(cp.headHash) ||
      cp.genesisHash !== mcpArchiveGenesis(cp.scopeId) ||
      !safeInteger(trustedAfterSequence) ||
      trustedAfterSequence > cp.endSequence ||
      !Number.isSafeInteger(trustedLimit) || trustedLimit < 1 || trustedLimit > 1000 ||
      !HASH.test(trustedPreviousHash) ||
      (trustedAfterSequence === 0 && trustedPreviousHash !== cp.genesisHash) ||
      !proof || proof.schema !== SCHEMA || proof.scopeId !== cp.scopeId ||
      proof.afterSequence !== trustedAfterSequence ||
      proof.previousHash !== trustedPreviousHash ||
      proof.limit !== trustedLimit || !Array.isArray(proof.records) ||
      proof.records.length > trustedLimit ||
      typeof proof.hasMore !== 'boolean' ||
      !safeInteger(proof.endSequence) || !HASH.test(proof.headHash)) return false;
  let sequence = trustedAfterSequence;
  let hash = trustedPreviousHash;
  try {
    for (const record of proof.records) {
      if (record?.sequence !== sequence + 1) return false;
      sequence++;
      hash = mcpArchiveRecordHash(cp.scopeId, hash, record);
    }
  } catch {
    return false;
  }
  if (proof.endSequence !== sequence || proof.headHash !== hash ||
      sequence > cp.endSequence) return false;
  const hasMore = sequence < cp.endSequence;
  return proof.hasMore === hasMore &&
    (hasMore
      ? proof.records.length === trustedLimit
      : sequence === cp.endSequence && hash === cp.headHash);
}
