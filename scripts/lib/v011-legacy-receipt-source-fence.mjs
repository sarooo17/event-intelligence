import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  inspectLegacyJsonlStore,
  LegacyJsonlPreflightError,
} from './v011-jsonl-upgrade-preflight.mjs';

// Deliberately narrow first recovery boundary: ONE quiesced default-scope
// JSONL store, ONE poll source, full old occurrence retention, every prior
// delivered host receipt found. Not a generic upgrade or provider verifier.
const refuse = code => { throw new LegacyJsonlPreflightError(code); };
const sha = value => createHash('sha256').update(value).digest('hex');
const MAX_ARCHIVED_EVENTS = 10000;
const MAX_RECEIPTS = 1024;

async function jsonl(folder, name) {
  const file = path.join(folder, name);
  let stat;
  try { stat = await lstat(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) refuse('UNSAFE_LEGACY_FILE');
  const raw = await readFile(file, 'utf8');
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024) refuse('UNSAFE_LEGACY_FILE');
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length > 25000) refuse('TOO_MANY_ROWS');
  try {
    return lines.map(line => {
      const parsed = JSON.parse(line);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        refuse('INVALID_LEGACY_ROW');
      }
      return parsed;
    });
  } catch (error) {
    if (error instanceof LegacyJsonlPreflightError) throw error;
    refuse('INVALID_LEGACY_ROW');
  }
}

async function snapshot(sourceDir, declaredVersion, digest) {
  const report = await inspectLegacyJsonlStore(sourceDir, { declaredVersion });
  if (report.sourceSnapshotSha256 !== digest) refuse('SOURCE_SNAPSHOT_CHANGED');
  if (report.scopeCount !== 1 || report.scopes[0].scope !== 'default') {
    refuse('MULTISCOPE_RECONCILIATION_NOT_SUPPORTED');
  }
  const counts = report.scopes[0].counts;
  if (counts.activeOrPausedWatches < 1 ||
      counts.missingWatchOwner ||
      counts.invalidDeliveredReceipts ||
      counts.inFlightDeliveries ||
      counts.activeOrPausedWatches !== counts.v1SchemaCompatibleWatches ||
      counts.latestDeliveries === 0 ||
      counts.latestDeliveries !== counts.deliveredReceipts) {
    refuse('LEGACY_STATE_NOT_RECONCILABLE');
  }
  return report;
}

function validateReceiptRow(row, runtime) {
  if (row.status !== 'delivered' || row.runtime !== runtime ||
      typeof row.wakeId !== 'string' || !row.wakeId ||
      typeof row.triggerId !== 'string' || !row.triggerId ||
      typeof row.triggerVersion !== 'string' || !row.triggerVersion ||
      typeof row.matchId !== 'string' || !row.matchId ||
      typeof row.runtimeReceiptId !== 'string' || !row.runtimeReceiptId) {
    refuse('LEGACY_DELIVERY_INVALID');
  }
}

function newest(rows, parts) {
  const result = new Map();
  for (const row of rows) {
    const values = parts.map(key => row[key]);
    if (values.some(v => typeof v !== 'string' || !v)) {
      refuse('INVALID_LEGACY_IDENTITY');
    }
    result.set(JSON.stringify(values), row);
  }
  return [...result.values()];
}

function exactSourceState(records) {
  // Even a legitimate v0.11 old installation may have several source
  // identities. Refuse the ambiguous case rather than silently filtering
  // a different connection, server, arguments or subscription.
  const states = newest(records, ['connectionId', 'eventName']);
  if (states.length !== 1) refuse('MULTISOURCE_RECONCILIATION_NOT_SUPPORTED');
  const state = states[0];
  for (const record of records) {
    if (record.connectionId !== state.connectionId ||
        record.eventName !== state.eventName ||
        record.serverId !== state.serverId ||
        record.deliveryMode !== 'poll' ||
        (record.subscriptionId !== null && record.subscriptionId !== undefined) ||
        (record.arguments !== undefined &&
          (!record.arguments || Array.isArray(record.arguments) ||
            typeof record.arguments !== 'object' ||
            Object.keys(record.arguments).length !== 0))) {
      refuse('HISTORICAL_SOURCE_IDENTITY_DRIFT');
    }
  }
  if (typeof state.serverId !== 'string' || !state.serverId ||
      typeof state.cursor !== 'string' || !state.cursor ||
      (state.arguments !== undefined &&
        (Array.isArray(state.arguments) || !state.arguments ||
          Object.keys(state.arguments).length !== 0)) ||
      state.subscriptionId !== null && state.subscriptionId !== undefined ||
      state.deliveryMode !== 'poll' || state.truncated === true || state.lastError) {
    refuse('SOURCE_FRONTIER_AMBIGUOUS');
  }
  return state;
}

/**
 * READ-ONLY host boundary. Authenticates old delivered receipts against
 * host-owned durable ledger and requires an EXTERNAL provider/operator
 * declaration of complete stable-ID replay through old checkpoint.
 *
 * The helper does not validate third-party provenance or certify a live
 * provider: the host callback is the trust boundary. It does not resume
 * paused watches or write the source/target/cursor. No SSE or push support.
 */
export async function prepareLegacyReceiptReplayFence({
  sourceDir,
  declaredVersion = '0.11.0',
  expectedSourceSnapshotSha256,
  runtime = 'muffin',
  tenantId,
  lookupHostReceipt,
  attestProviderSource,
} = {}) {
  if (typeof sourceDir !== 'string' || !sourceDir ||
      typeof expectedSourceSnapshotSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(expectedSourceSnapshotSha256) ||
      typeof runtime !== 'string' || !runtime ||
      typeof tenantId !== 'string' || !tenantId ||
      typeof lookupHostReceipt !== 'function' ||
      typeof attestProviderSource !== 'function') {
    refuse('EXPLICIT_HOST_AND_SOURCE_EVIDENCE_REQUIRED');
  }
  const before = await snapshot(sourceDir, declaredVersion, expectedSourceSnapshotSha256);
  const [definitions, triggerStates, deliveryRows, sourceRows, archiveRows] =
    await Promise.all([
      jsonl(sourceDir, 'triggers.jsonl'),
      jsonl(sourceDir, 'trigger-states.jsonl'),
      jsonl(sourceDir, 'wake-deliveries.jsonl'),
      jsonl(sourceDir, 'mcp-client-states.jsonl'),
      jsonl(sourceDir, 'mcp-events.jsonl'),
    ]);
  const latestStates = new Map();
  for (const row of triggerStates) {
    latestStates.set(JSON.stringify([row.triggerId, row.version]), row);
  }
  for (const trigger of definitions) {
    const state = latestStates.get(JSON.stringify([trigger.triggerId, trigger.version]));
    if (['active', 'paused'].includes(state?.status ?? 'active') &&
        (state?.owner?.tenant_id !== tenantId || state.owner.type !== 'owner')) {
      refuse('HOST_TENANT_REAUTHORIZATION_REQUIRED');
    }
  }

  const receipts = newest(deliveryRows, ['wakeId']);
  if (receipts.length > MAX_RECEIPTS) refuse('TOO_MANY_RECEIPTS');
  const ids = new Set();
  for (const row of receipts) {
    validateReceiptRow(row, runtime);
    if (ids.has(row.runtimeReceiptId)) refuse('DUPLICATE_HOST_RECEIPT');
    ids.add(row.runtimeReceiptId);
    const proof = await lookupHostReceipt({
      scopeId: 'default', tenantId, runtime,
      receiptId: row.runtimeReceiptId,
      wakeId: row.wakeId,
      triggerId: row.triggerId,
      triggerVersion: row.triggerVersion,
    });
    if (proof?.receiptId !== row.runtimeReceiptId ||
        proof?.tenantId !== tenantId || proof?.runtime !== runtime ||
        proof?.state !== 'durable' ||
        proof?.principalKind !== 'system' ||
        proof?.principalSource !== 'automation') {
      refuse('HOST_RECEIPT_MISSING_OR_MISMATCHED');
    }
  }

  const source = exactSourceState(sourceRows);
  const oldIds = new Set();
  if (archiveRows.length === 0 || archiveRows.length > MAX_ARCHIVED_EVENTS) {
    refuse('SOURCE_ARCHIVE_INCOMPLETE_OR_OVERSIZED');
  }
  let lastSequence = 0;
  for (const record of archiveRows) {
    if (!Number.isSafeInteger(record.sequence) ||
        record.sequence !== lastSequence + 1 ||
        record.serverId !== source.serverId ||
        record.subscriptionId !== null && record.subscriptionId !== undefined ||
        record.event?.name !== source.eventName ||
        typeof record.event?.eventId !== 'string' || !record.event.eventId ||
        oldIds.has(record.event.eventId)) {
      refuse('SOURCE_ARCHIVE_IDENTITY_AMBIGUOUS');
    }
    oldIds.add(record.event.eventId);
    lastSequence = record.sequence;
  }
  const idDigest = sha(JSON.stringify([...oldIds].sort()));
  const declared = await attestProviderSource(Object.freeze({
    scopeId: 'default',
    connectionId: source.connectionId,
    serverId: source.serverId,
    eventName: source.eventName,
    legacyCursor: source.cursor,
    archivedEventCount: oldIds.size,
    archivedEventIdsSha256: idDigest,
  }));
  if (declared?.connectionId !== source.connectionId ||
      declared?.serverId !== source.serverId ||
      declared?.eventName !== source.eventName ||
      declared?.legacyCursor !== source.cursor ||
      declared?.archivedEventIdsSha256 !== idDigest ||
      declared?.stableEventIds !== true ||
      declared?.immutableEventIdMapping !== true ||
      declared?.completeReplayThroughLegacyCursor !== true ||
      declared?.noUnreportedGaps !== true ||
      declared?.supportsPolling !== true) {
    refuse('PROVIDER_SOURCE_CONTINUITY_NOT_ATTESTED');
  }
  await snapshot(sourceDir, declaredVersion, expectedSourceSnapshotSha256);

  let rejectedOld = 0;
  let passedNew = 0;
  const wrapConnection = connection => {
    if (!connection || typeof connection !== 'object' ||
        connection.connectionId !== source.connectionId ||
        connection.serverId !== source.serverId ||
        typeof connection.request !== 'function') {
      refuse('MCP_CONNECTION_IDENTITY_MISMATCH');
    }
    return Object.freeze({
      ...connection,
      async request(method, ...args) {
        const result = await connection.request(method, ...args);
        if (method !== 'events/poll') return result;
        if (!result || typeof result !== 'object' ||
            !Array.isArray(result.events) ||
            typeof result.hasMore !== 'boolean' ||
            (result.cursor !== null && typeof result.cursor !== 'string')) {
          refuse('MCP_POLL_RESULT_AMBIGUOUS');
        }
        const filtered = [];
        for (const event of result.events) {
          if (!event || typeof event !== 'object' ||
              typeof event.eventId !== 'string' || !event.eventId ||
              event.name !== source.eventName) {
            refuse('MCP_REPLAY_EVENT_IDENTITY_AMBIGUOUS');
          }
          if (oldIds.has(event.eventId)) {
            rejectedOld += 1;
          } else {
            filtered.push(event);
            passedNew += 1;
          }
        }
        return { ...result, events: filtered };
      },
    });
  };
  return Object.freeze({
    status: 'host-declared-synthetic-source-replay-fence',
    migrationPerformed: false,
    productionProviderIndependentlyCertified: false,
    safeToResumeOrDeploy: false,
    historicalReceiptsReconciled: receipts.length,
    archivedEventIdsCount: oldIds.size,
    sourceSnapshotSha256: before.sourceSnapshotSha256,
    replayStats: () => Object.freeze({ rejectedOld, passedNew }),
    wrapConnection,
  });
}
