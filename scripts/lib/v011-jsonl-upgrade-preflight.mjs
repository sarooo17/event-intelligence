import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseCompositeTriggerDefinition } from '../../dist/src/intelligenceProtocol/index.js';

// This is a read-only, operator-facing preflight for a QUIESCED JSONL Home
// produced by the published 0.11.0 store. Files alone cannot authenticate
// their package provenance or prove provider replay completeness.
// No marker adoption, no replay, no consumer mutation and no writing.
const LEGACY_VERSION = '0.11.0';
const MAX_FILES = 80;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ROWS_PER_FILE = 25000;
const LEGACY_JSONL_FILES = new Set([
  'wakes.jsonl', 'wake-deliveries.jsonl', 'triggers.jsonl',
  'trigger-states.jsonl', 'event-sources.jsonl', 'trigger-matches.jsonl',
  'mcp-events.jsonl', 'mcp-client-states.jsonl', 'temporal-deadlines.jsonl',
  'derived-events.jsonl', 'derived-contracts.jsonl',
  'semantic-decision-cache.jsonl', 'partition-leases.jsonl', 'audit.jsonl',
]);
const UNSAFE_HISTORY_FILES = [
  'wakes.jsonl', 'trigger-matches.jsonl', 'mcp-events.jsonl',
  'temporal-deadlines.jsonl', 'derived-events.jsonl',
  'semantic-decision-cache.jsonl', 'partition-leases.jsonl',
  'audit.jsonl',
];

export class LegacyJsonlPreflightError extends Error {
  constructor(code) {
    super('Legacy JSONL preflight refused: ' + code);
    this.name = 'LegacyJsonlPreflightError';
    this.code = code;
  }
}

const reject = code => { throw new LegacyJsonlPreflightError(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function regularFileBytes(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) reject('UNSAFE_FILE');
  const bytes = await readFile(file);
  if (bytes.length > MAX_FILE_BYTES) reject('UNSAFE_FILE');
  return bytes;
}

async function inventoryScope(folder, isRoot = false) {
  const files = new Map();
  const entries = await readdir(folder, { withFileTypes: true });
  if (entries.length > MAX_FILES) reject('TOO_MANY_FILES');
  for (const entry of entries) {
    if (isRoot && entry.name === 'scopes' && entry.isDirectory()) continue;
    if (!entry.isFile() || !LEGACY_JSONL_FILES.has(entry.name)) {
      reject('UNRECOGNIZED_OR_NONREGULAR_STORE_ENTRY');
    }
    files.set(entry.name, await regularFileBytes(path.join(folder, entry.name)));
  }

  const records = new Map();
  for (const [name, bytes] of files) {
    const raw = bytes.toString('utf8');
    const lines = raw.length ? raw.split('\n') : [];
    if (lines.at(-1) === '') lines.pop();
    if (lines.length > MAX_ROWS_PER_FILE) reject('TOO_MANY_ROWS');
    const parsed = [];
    for (const line of lines) {
      if (!line.trim()) reject('INVALID_JSONL_RECORD');
      let value;
      try { value = JSON.parse(line); } catch { reject('INVALID_JSONL_RECORD'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        reject('INVALID_JSONL_RECORD');
      }
      parsed.push(value);
    }
    records.set(name, parsed);
  }
  const rows = name => records.get(name) ?? [];
  const triggers = new Map();
  for (const row of rows('triggers.jsonl')) {
    if (typeof row.triggerId !== 'string' || typeof row.version !== 'string') {
      reject('INVALID_TRIGGER_IDENTITY');
    }
    const key = JSON.stringify([row.triggerId, row.version]);
    if (triggers.has(key)) reject('AMBIGUOUS_TRIGGER_IDENTITY');
    triggers.set(key, row);
  }
  const states = new Map();
  for (const row of rows('trigger-states.jsonl')) {
    if (typeof row.triggerId !== 'string' || typeof row.version !== 'string' ||
        !['active', 'paused', 'completed', 'expired', 'deleted'].includes(row.status)) {
      reject('INVALID_TRIGGER_STATE');
    }
    states.set(JSON.stringify([row.triggerId, row.version]), row);
  }
  for (const key of states.keys()) {
    if (!triggers.has(key)) reject('ORPHAN_TRIGGER_STATE');
  }

  const deliveries = new Map();
  for (const row of rows('wake-deliveries.jsonl')) {
    if (typeof row.wakeId !== 'string' || !row.wakeId.trim() ||
        !['pending', 'claimed', 'retry_pending', 'delivered', 'dead_letter'].includes(row.status)) {
      reject('INVALID_WAKE_DELIVERY');
    }
    deliveries.set(row.wakeId, row);
  }
  const statuses = [...deliveries.values()];
  const active = [...triggers].filter(([key]) =>
    ['active', 'paused'].includes(states.get(key)?.status ?? 'active'));
  let v1SchemaCompatibleWatches = 0;
  for (const [, definition] of active) {
    try {
      parseCompositeTriggerDefinition(definition);
      v1SchemaCompatibleWatches += 1;
    } catch {
      // Do not leak individual trigger contents or zod's user-value errors.
    }
  }
  const missingOwner = active.filter(([key]) => {
    const owner = states.get(key)?.owner;
    return !owner || typeof owner !== 'object' ||
      typeof owner.type !== 'string' || typeof owner.principal_id !== 'string';
  });
  const invalidReceipts = statuses.filter(row =>
    row.status === 'delivered' &&
    (typeof row.runtimeReceiptId !== 'string' || !row.runtimeReceiptId.trim()));
  const inFlight = statuses.filter(row =>
    ['pending', 'claimed', 'retry_pending'].includes(row.status));

  const reasons = new Set();
  if (active.length) reasons.add('OWNER_REAUTHORIZATION_REQUIRED');
  if (missingOwner.length) reasons.add('MISSING_WATCH_OWNER');
  if (v1SchemaCompatibleWatches !== active.length) {
    reasons.add('V1_TRIGGER_DEFINITION_REVIEW_REQUIRED');
  }
  if (statuses.length) reasons.add('HOST_RECEIPT_RECONCILIATION_REQUIRED');
  if (invalidReceipts.length) reasons.add('UNPROVEN_DELIVERED_RECEIPT');
  if (inFlight.length) reasons.add('INFLIGHT_WAKE_RECONCILIATION_REQUIRED');
  if (rows('mcp-client-states.jsonl').length) reasons.add('SOURCE_CURSOR_REPLAY_PROOF_REQUIRED');
  if (rows('event-sources.jsonl').length) reasons.add('SOURCE_CAPABILITY_REDISCOVERY_REQUIRED');
  if (rows('derived-contracts.jsonl').length) reasons.add('DERIVED_CONTRACT_REVIEW_REQUIRED');
  if (UNSAFE_HISTORY_FILES.some(name => rows(name).length)) {
    reasons.add('PATTERN_HISTORY_NOT_TRANSFERABLE');
  }
  if (active.length && !rows('mcp-client-states.jsonl').length) {
    reasons.add('SOURCE_REPLAY_BOUNDARY_UNKNOWN');
  }
  if (!triggers.size && !statuses.length) reasons.add('NO_LEGACY_WATCH_TO_RECONSTRUCT');
  // Even a candidate with no explicit reason is NOT authorized to migrate:
  // a package version marker is absent from 0.11 JSONL, and a read-only scan
  // cannot establish that all source writers have stopped.
  reasons.add('OPERATOR_QUIESCENCE_AND_PROVENANCE_REQUIRED');

  const fileEntries = [...files].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bytes]) => ({ name, sha256: hash(bytes), bytes: bytes.length }));
  return {
    counts: {
      totalWatches: triggers.size, activeOrPausedWatches: active.length,
      missingWatchOwner: missingOwner.length,
      v1SchemaCompatibleWatches,
      latestDeliveries: statuses.length,
      deliveredReceipts: statuses.filter(x => x.status === 'delivered').length,
      inFlightDeliveries: inFlight.length,
      invalidDeliveredReceipts: invalidReceipts.length,
      mcpCursorUpdates: rows('mcp-client-states.jsonl').length,
      oldPatternHistoryRows: UNSAFE_HISTORY_FILES
        .reduce((sum, name) => sum + rows(name).length, 0),
    },
    reasons: [...reasons].sort(),
    files: fileEntries,
  };
}

async function inventoryRoot(dataDir) {
  const stat = await lstat(dataDir);
  if (!stat.isDirectory()) reject('NOT_A_DIRECTORY');
  const root = await readdir(dataDir, { withFileTypes: true });
  if (root.length > MAX_FILES) reject('TOO_MANY_FILES');
  const rootEntries = root.filter(x => x.name !== 'scopes');
  const scopedDir = root.find(x => x.name === 'scopes');
  for (const entry of rootEntries) {
    if (!entry.isFile() || !LEGACY_JSONL_FILES.has(entry.name)) {
      reject('UNRECOGNIZED_OR_NONREGULAR_STORE_ENTRY');
    }
  }
  const scopes = [{ scope: 'default', dir: dataDir }];
  if (scopedDir) {
    if (!scopedDir.isDirectory()) reject('UNRECOGNIZED_OR_NONREGULAR_STORE_ENTRY');
    const names = await readdir(path.join(dataDir, 'scopes'), { withFileTypes: true });
    if (names.length > MAX_FILES) reject('TOO_MANY_SCOPES');
    for (const entry of names) {
      if (!entry.isDirectory()) reject('UNRECOGNIZED_OR_NONREGULAR_STORE_ENTRY');
      const scope = Buffer.from(entry.name, 'base64url').toString('utf8');
      if (!scope || scope !== scope.trim() || scope.length > 240 ||
          scope === 'default' ||
          Buffer.from(scope, 'utf8').toString('base64url') !== entry.name) {
        reject('INVALID_SCOPE_DIRECTORY');
      }
      scopes.push({ scope, dir: path.join(dataDir, 'scopes', entry.name) });
    }
  }
  return scopes.sort((a, b) => a.scope.localeCompare(b.scope));
}

/**
 * Operator must supply the installed source version from a trusted package
 * manifest/lock; JSONL itself does not embed authoritative npm provenance.
 * No raw watch, owner or event payloads are returned in the report.
 */
export async function inspectLegacyJsonlStore(dataDir, { declaredVersion } = {}) {
  if (declaredVersion !== LEGACY_VERSION) reject('UNSUPPORTED_SOURCE_VERSION');
  const list = await inventoryRoot(dataDir);
  const first = [];
  for (const item of list) {
    first.push({ scope: item.scope, ...(await inventoryScope(item.dir, item.scope === 'default')) });
  }
  // A repeat inventory catches ordinary concurrent mutations. This is NOT
  // a POSIX lock or a proof that no external writer is running.
  const second = await inventoryRoot(dataDir);
  if (JSON.stringify(second) !== JSON.stringify(list)) reject('CONCURRENT_SOURCE_MUTATION');
  const verified = [];
  for (const item of second) {
    verified.push({ scope: item.scope, ...(await inventoryScope(item.dir, item.scope === 'default')) });
  }
  if (JSON.stringify(first) !== JSON.stringify(verified)) reject('CONCURRENT_SOURCE_MUTATION');

  const digest = hash(JSON.stringify(first.map(x =>
    ({ scope: x.scope, files: x.files }))));
  return Object.freeze({
    schema: 'ei-legacy-jsonl-preflight.v1',
    declaredVersion,
    status: 'blocked',
    migrationPerformed: false,
    sourceReadOnly: true,
    provenanceVerifiedByFiles: false,
    operatorQuiescenceVerifiedByFiles: false,
    sourceSnapshotSha256: digest,
    scopeCount: first.length,
    scopes: first.map(({ scope, counts, reasons }) => ({ scope, counts, reasons })),
  });
}
