import { createHash } from 'node:crypto';
import { McpEventOccurrenceSchema } from '../../dist/src/intelligenceProtocol/index.js';

const SCHEMA = 'event-intelligence.mcp-occurrence-archive.v1';
const HASH = /^[0-9a-f]{64}$/;
const safeInteger = n => Number.isSafeInteger(n) && n >= 0;
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');

export function mcpArchiveGenesis(scopeId) {
  if (typeof scopeId !== 'string' || !scopeId) {
    throw new TypeError('Archive scopeId must be nonempty');
  }
  return digest(JSON.stringify([SCHEMA, scopeId, 'genesis']));
}

/**
 * Exact PG JSONB::text is the archive wire representation. Do not pass
 * parsed JSON here: node-postgres uses JS Number and can conflate distinct
 * PostgreSQL numeric values beyond 2^53. Hash the original lossless text.
 */
export function mcpArchiveRecordHash(scopeId, previousHash, payloadJson) {
  if (typeof scopeId !== 'string' || !scopeId || !HASH.test(previousHash) ||
      typeof payloadJson !== 'string' || !payloadJson) {
    throw new TypeError('Invalid MCP archive scope, predecessor or raw payload');
  }
  let parsed;
  try {
    parsed = JSON.parse(payloadJson);
    if (!Number.isSafeInteger(parsed?.sequence) || parsed.sequence < 1 ||
        typeof parsed.serverId !== 'string' || !parsed.serverId ||
        !(parsed.subscriptionId === null ||
          typeof parsed.subscriptionId === 'string') ||
        !McpEventOccurrenceSchema.safeParse(parsed.event).success) {
      throw new Error('MCP archive occurrence does not satisfy source schema');
    }
  } catch {
    throw new TypeError('Malformed MCP archive source occurrence');
  }
  // The exact PostgreSQL JSONB textual representation is committed bytewise,
  // including every numeric lexeme (not lossy JSON.parse / JSON.stringify).
  return digest(JSON.stringify([SCHEMA, scopeId, previousHash, payloadJson]));
}

/**
 * Independent verification REQUIRES a separately pinned trust root, plus the
 * previous hash retained from an independently validated preceding page.
 * The database must not be trusted to choose its own root during verification.
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
    for (const payloadJson of proof.records) {
      // Parsing here is ONLY for shape/sequence validation. The commitment
      // always covers the exact PG JSONB text, not reserialized JS numbers.
      if (typeof payloadJson !== 'string' ||
          JSON.parse(payloadJson)?.sequence !== sequence + 1) return false;
      sequence++;
      hash = mcpArchiveRecordHash(cp.scopeId, hash, payloadJson);
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
