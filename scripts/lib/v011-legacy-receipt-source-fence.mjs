import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isProxy } from 'node:util/types';
import { snapshotUntrustedEventData } from '../../dist/src/protocol/ownPath.js';
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
const MAX_EVENT_IDENTITY_BYTES = 32 * 1024;
function snapshotMcpWireResult(raw) {
  try { return snapshotUntrustedEventData(raw); }
  catch { refuse('MCP_WIRE_SNAPSHOT_INVALID'); }
}


function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map(key => [key, stableJson(value[key])]));
  }
  return value;
}

function archivedEventFingerprint(raw) {
  let event;
  try { event = snapshotUntrustedEventData(raw); }
  catch { refuse('SOURCE_EVENT_DATA_INVALID'); }
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      typeof event.name !== 'string' || !event.name ||
      typeof event.timestamp !== 'string' || !event.timestamp ||
      !event.data || typeof event.data !== 'object' ||
      Array.isArray(event.data)) {
    refuse('SOURCE_EVENT_DATA_INVALID');
  }
  const identity = JSON.stringify(stableJson({
    name: event.name, timestamp: event.timestamp, data: event.data,
  }));
  if (Buffer.byteLength(identity) > MAX_EVENT_IDENTITY_BYTES) {
    refuse('SOURCE_EVENT_DATA_TOO_LARGE');
  }
  return sha(identity);
}

function assertImmutableWakeHistory(rows) {
  const history = new Map();
  for (const row of rows) {
    if (typeof row.wakeId !== 'string' || !row.wakeId) {
      refuse('LEGACY_DELIVERY_IDENTITY_CHANGED');
    }
    const identity = JSON.stringify([
      row.runtime, row.matchId, row.triggerId, row.triggerVersion,
    ]);
    const previous = history.get(row.wakeId);
    if (previous && (previous.identity !== identity ||
        (row.status === 'delivered' && previous.deliveredReceipt !== null &&
          previous.deliveredReceipt !== row.runtimeReceiptId))) {
      refuse('LEGACY_DELIVERY_IDENTITY_CHANGED');
    }
    history.set(row.wakeId, {
      identity,
      deliveredReceipt: row.status === 'delivered'
        ? row.runtimeReceiptId
        : previous?.deliveredReceipt ?? null,
    });
  }
}


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
        (record.subscriptionId ?? null) !== (state.subscriptionId ?? null) ||
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
      (state.subscriptionId !== null && state.subscriptionId !== undefined &&
        (typeof state.subscriptionId !== 'string' || !state.subscriptionId)) ||
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
  hostGapJournal = null,
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

  assertImmutableWakeHistory(deliveryRows);
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
  const oldEventFingerprints = new Map();
  if (archiveRows.length === 0 || archiveRows.length > MAX_ARCHIVED_EVENTS) {
    refuse('SOURCE_ARCHIVE_INCOMPLETE_OR_OVERSIZED');
  }
  let lastSequence = 0;
  for (const record of archiveRows) {
    if (!Number.isSafeInteger(record.sequence) ||
        record.sequence !== lastSequence + 1 ||
        record.serverId !== source.serverId ||
        (record.subscriptionId ?? null) !== (source.subscriptionId ?? null) ||
        record.event?.name !== source.eventName ||
        typeof record.event?.eventId !== 'string' || !record.event.eventId ||
        oldIds.has(record.event.eventId)) {
      refuse('SOURCE_ARCHIVE_IDENTITY_AMBIGUOUS');
    }
    oldIds.add(record.event.eventId);
    oldEventFingerprints.set(record.event.eventId,
      archivedEventFingerprint(record.event));
    lastSequence = record.sequence;
  }
  const idDigest = sha(JSON.stringify([...oldIds].sort()));
  const declared = await attestProviderSource(Object.freeze({
    scopeId: 'default',
    connectionId: source.connectionId,
    serverId: source.serverId,
    eventName: source.eventName,
    legacyCursor: source.cursor,
    subscriptionId: source.subscriptionId ?? null,
    archivedEventCount: oldIds.size,
    archivedEventIdsSha256: idDigest,
  }));
  if (declared?.connectionId !== source.connectionId ||
      declared?.serverId !== source.serverId ||
      declared?.eventName !== source.eventName ||
      declared?.legacyCursor !== source.cursor ||
      (declared?.subscriptionId ?? null) !== (source.subscriptionId ?? null) ||
      declared?.archivedEventIdsSha256 !== idDigest ||
      declared?.stableEventIds !== true ||
      declared?.cursorPortableToTargetVersion !== true ||
      declared?.immutableEventIdMapping !== true ||
      declared?.completeReplayThroughLegacyCursor !== true ||
      declared?.noUnreportedGaps !== true ||
      declared?.supportsPolling !== true) {
    refuse('PROVIDER_SOURCE_CONTINUITY_NOT_ATTESTED');
  }
  await snapshot(sourceDir, declaredVersion, expectedSourceSnapshotSha256);

  // The host must have created/opened this ledger before it allows the
  // recovery source to poll. Exact old source + tenant binding prevents a
  // ready ledger from being accidentally reused for another archive.
  if (hostGapJournal) {
    if (hostGapJournal.sourceSnapshotSha256 !== expectedSourceSnapshotSha256 ||
        hostGapJournal.sourceIdentitySha256 !== idDigest ||
        hostGapJournal.tenantId !== tenantId ||
        typeof hostGapJournal.assertReady !== 'function' ||
        typeof hostGapJournal.beginPoll !== 'function' ||
        typeof hostGapJournal.validated !== 'function' ||
        typeof hostGapJournal.block !== 'function') {
      refuse('HOST_GAP_JOURNAL_BINDING_MISMATCH');
    }
    await hostGapJournal.assertReady();
  }

  let rejectedOld = 0;
  let passedNew = 0;
  // Memory-only safety latch: once an MCP provider reports a gap/no-replay
  // page, do not let a clean retry silently pass. This is NOT a durable
  // restart fence or a replacement for a host-owned persisted gap ledger.
  let continuityLost = false;
  const wrapConnection = connection => {
    if (!connection || typeof connection !== 'object' ||
        connection.connectionId !== source.connectionId ||
        connection.serverId !== source.serverId ||
        (connection.scopeId !== undefined && connection.scopeId !== 'default') ||
        (connection.preferredDelivery !== undefined &&
          connection.preferredDelivery !== 'poll') ||
        connection.openEventStream !== undefined ||
        connection.createWebhookSubscription !== undefined ||
        typeof connection.request !== 'function') {
      refuse('MCP_CONNECTION_IDENTITY_MISMATCH');
    }
    return Object.freeze({
      ...connection,
      async request(method, ...args) {
        if (continuityLost && typeof method === 'string' &&
            method.startsWith('events/')) {
          refuse('MCP_SOURCE_CONTINUITY_LOST');
        }
        if (hostGapJournal && typeof method === 'string' &&
            method.startsWith('events/')) {
          await hostGapJournal.assertReady();
        }
        if (method === 'events/list') {
          const result = snapshotMcpWireResult(
            await connection.request(method, ...args));
          if (!result || !Array.isArray(result.events) ||
              result.events.length !== 1 ||
              (result.nextCursor !== undefined && result.nextCursor !== null) ||
              result.events[0]?.name !== source.eventName ||
              !Array.isArray(result.events[0].delivery) ||
              !result.events[0].delivery.includes('poll')) {
            refuse('MCP_SOURCE_DISCOVERY_OUTSIDE_REPLAY_PROFILE');
          }
          return {
            ...result,
            // Never advertise a delivery mode that bypasses our poll fence.
            events: [{ ...result.events[0], delivery: ['poll'] }],
          };
        }
        if (method !== 'events/poll') {
          if (typeof method === 'string' && method.startsWith('events/')) {
            refuse('MCP_UNSUPPORTED_EVENT_DELIVERY_METHOD');
          }
          return connection.request(method, ...args);
        }
        const params = args[0];
        if (!params || typeof params !== 'object' || Array.isArray(params) ||
            params.name !== source.eventName ||
            !params.arguments || typeof params.arguments !== 'object' ||
            Array.isArray(params.arguments) ||
            Object.keys(params.arguments).length !== 0 ||
            (params.cursor !== null && typeof params.cursor !== 'string')) {
          refuse('MCP_POLL_REQUEST_IDENTITY_AMBIGUOUS');
        }
        // MCP Events: null means START FROM NOW, not "resume old history".
        // The NEW v1 store has no source cursor by design. Intercept only
        // that first null and supply the host-attested old opaque cursor.
        // If v1 subsequently has a cursor, do not override its progress.
        const cursor = params.cursor === null ? source.cursor : params.cursor;
        if (!cursor) refuse('MCP_POLL_REQUEST_CURSOR_AMBIGUOUS');
        if (hostGapJournal) await hostGapJournal.beginPoll({ cursor });
        try {
        const rawResult = await connection.request(method,
          { ...params, cursor }, ...args.slice(1));
        // Preserve a gap BEFORE a fallible full-page snapshot. Oversized,
        // accessor-backed or otherwise invalid pages must not erase the
        // provider's own-data truncated signal.
        if (rawResult && typeof rawResult === 'object' && !isProxy(rawResult)) {
          const descriptor = Object.getOwnPropertyDescriptor(rawResult, 'truncated');
          if (descriptor && Object.hasOwn(descriptor, 'value') &&
              descriptor.value === true) {
            continuityLost = true;
          }
        }
        let result;
        try { result = snapshotMcpWireResult(rawResult); }
        catch (error) {
          continuityLost = true;
          throw error;
        }
        if (continuityLost || result?.truncated === true ||
            result?.cursor === null || result?.cursor === undefined) {
          continuityLost = true;
          refuse('MCP_SOURCE_CONTINUITY_LOST');
        }
        if (!result || typeof result !== 'object' ||
            !Array.isArray(result.events) ||
            typeof result.hasMore !== 'boolean' ||
            typeof result.cursor !== 'string' || !result.cursor ||
            (result.truncated !== undefined &&
              typeof result.truncated !== 'boolean')) {
          refuse('MCP_POLL_RESULT_AMBIGUOUS');
        }
        const filtered = [];
        for (const rawEvent of result.events) {
          let event;
          try { event = snapshotUntrustedEventData(rawEvent); }
          catch { refuse('MCP_REPLAY_EVENT_IDENTITY_AMBIGUOUS'); }
          if (!event || typeof event !== 'object' ||
              typeof event.eventId !== 'string' || !event.eventId ||
              event.name !== source.eventName) {
            refuse('MCP_REPLAY_EVENT_IDENTITY_AMBIGUOUS');
          }
          const fingerprint = archivedEventFingerprint(event);
          if (oldIds.has(event.eventId)) {
            if (oldEventFingerprints.get(event.eventId) !== fingerprint) {
              continuityLost = true;
              refuse('MCP_REPLAY_EVENT_CONTENT_COLLISION');
            }
            rejectedOld += 1;
          } else {
            filtered.push(event);
            passedNew += 1;
          }
        }
        if (hostGapJournal) {
          await hostGapJournal.validated({ cursor: result.cursor });
        }
        return { ...result, events: filtered };
        } catch (error) {
          continuityLost = true;
          if (hostGapJournal) {
            // Even a provider crash or malformed page is an unresolved gap
            // until an independently authorized host recovery. A failure of
            // the durable journal write is also a hard error, never success.
            await hostGapJournal.block();
          }
          throw error;
        }
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
    continuityLost: () => continuityLost,
    wrapConnection,
  });
}
