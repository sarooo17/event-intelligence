export { openLegacyHostGapJournal } from './lib/v011-host-gap-journal.mjs';
import { prepareLegacyReceiptReplayFence } from './lib/v011-legacy-receipt-source-fence.mjs';
import { LegacyJsonlPreflightError } from './lib/v011-jsonl-upgrade-preflight.mjs';

// Experimental, runtime-neutral, offline v0.11 recovery host bridge.
// Does NOT add an EI agent, scheduler, MCP transport, authorization store,
// distributed lock or real-provider certification.
const refuse = code => { throw new LegacyJsonlPreflightError(code); };
const validId = v => typeof v === 'string' && v.length > 0 &&
  v.length <= 240 && v === v.trim();
const validSha = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const validCursor = v => typeof v === 'string' && v.length > 0 && v.length <= 4096;
const requireFn = (obj, method) => {
  if (typeof obj?.[method] !== 'function') refuse('RECOVERY_HOST_CAPABILITY_REQUIRED');
};
const safeHostError = error => {
  // Don't leak host secrets, provider payloads or callback internals through
  // the recovery boundary. Fail closed for every host callback rejection.
  if (error instanceof LegacyJsonlPreflightError) return error;
  return new LegacyJsonlPreflightError('RECOVERY_HOST_CALLBACK_FAILED');
};

/**
 * Runtime-neutral integration point. The host supplies adapters; EI never
 * opens the host's database or interprets a host-specific receipt schema.
 *
 * authority.assertExclusive() MUST be a host-backed strict single-owner
 * lease/fencing assertion and return the same epoch across all calls.
 * A callback alone does not implement distributed fencing. Hosts MUST enforce
 * the epoch when performing side effects and revoke stale workers.
 *
 * receipts.lookup() MUST independently read a durable host-issued receipt.
 * source.attestContinuity() MUST be backed by provider-level evidence.
 * checkpoints.readDurable() MUST reopen host-owned committed source progress.
 */
export function createLegacyRecoveryHostBridge({
  runtimeId, tenantId, scopeId = 'default',
  authority, receipts, source, checkpoints,
} = {}) {
  if (!validId(runtimeId) || !validId(tenantId) || scopeId !== 'default') {
    refuse('RECOVERY_HOST_IDENTITY_REQUIRED');
  }
  for (const [port, method] of [
    [authority, 'assertExclusive'],
    [receipts, 'lookup'],
    [source, 'attestContinuity'],
    [checkpoints, 'readDurable'],
  ]) requireFn(port, method);

  let capturedEpoch = null;
  async function assertExclusive({ expectedSourceSnapshotSha256, sourceIdentitySha256 }) {
    if (!validSha(expectedSourceSnapshotSha256) ||
        !validSha(sourceIdentitySha256)) {
      refuse('RECOVERY_HOST_SOURCE_BINDING_REQUIRED');
    }
    let result;
    try {
      result = await authority.assertExclusive(Object.freeze({
        runtimeId, tenantId, scopeId, expectedSourceSnapshotSha256,
        sourceIdentitySha256,
      }));
    } catch (error) { throw safeHostError(error); }
    if (result?.exclusive !== true || result?.runtimeId !== runtimeId ||
        result?.tenantId !== tenantId || result?.scopeId !== scopeId ||
        !validId(result?.epoch)) {
      refuse('RECOVERY_HOST_EXCLUSIVE_EPOCH_REQUIRED');
    }
    if (capturedEpoch && result.epoch !== capturedEpoch) {
      refuse('RECOVERY_HOST_EPOCH_CHANGED');
    }
    capturedEpoch = result.epoch;
    return capturedEpoch;
  }
  async function lookupReceipt(request) {
    if (request?.runtime !== runtimeId || request?.tenantId !== tenantId ||
        request?.scopeId !== scopeId ||
        !validId(request?.receiptId) || !validId(request?.wakeId)) {
      refuse('RECOVERY_HOST_RECEIPT_REQUEST_MISMATCH');
    }
    let row;
    try {
      row = await receipts.lookup(Object.freeze({
        runtimeId, tenantId, scopeId, epoch: capturedEpoch,
        receiptId: request.receiptId, wakeId: request.wakeId,
        triggerId: request.triggerId, triggerVersion: request.triggerVersion,
      }));
    } catch (error) { throw safeHostError(error); }
    // Adapt only an explicitly declared portable receipt shape.
    if (row?.receiptId !== request.receiptId || row?.wakeId !== request.wakeId ||
        row?.runtimeId !== runtimeId || row?.tenantId !== tenantId ||
        row?.scopeId !== scopeId || row?.state !== 'durable' ||
        row?.principalKind !== 'system' || row?.principalSource !== 'automation') {
      refuse('RECOVERY_HOST_DURABLE_RECEIPT_MISMATCH');
    }
    return Object.freeze({
      receiptId: row.receiptId, runtime: runtimeId, tenantId,
      state: 'durable', principalKind: 'system', principalSource: 'automation',
    });
  }
  async function attestSource(evidence) {
    if (evidence?.scopeId !== scopeId) {
      refuse('RECOVERY_HOST_SOURCE_ATTESTATION_MISMATCH');
    }
    try {
      return await source.attestContinuity(Object.freeze({
        ...evidence, runtimeId, tenantId, epoch: capturedEpoch,
      }));
    } catch (error) { throw safeHostError(error); }
  }
  async function readCheckpoint({ connectionId, eventName, cursor }) {
    if (!validId(connectionId) || !validId(eventName) || !validCursor(cursor)) {
      refuse('RECOVERY_HOST_CHECKPOINT_BINDING_REQUIRED');
    }
    let proof;
    try {
      proof = await checkpoints.readDurable(Object.freeze({
        runtimeId, tenantId, scopeId, epoch: capturedEpoch,
        connectionId, eventName, cursor,
      }));
    } catch (error) { throw safeHostError(error); }
    return proof?.runtimeId === runtimeId && proof?.tenantId === tenantId &&
      proof?.scopeId === scopeId && proof?.connectionId === connectionId &&
      proof?.eventName === eventName && proof?.cursor === cursor &&
      proof?.durable === true && proof?.gapUnresolved === false &&
      proof?.truncated === false;
  }
  return Object.freeze({
    runtimeId, tenantId, scopeId,
    assertExclusive, lookupReceipt, attestSource, readCheckpoint,
  });
}

/**
 * Compose the generic host ports with the existing legacy read-only
 * reconciliation, without teaching EI about any specific host schema.
 *
 * This creates a *verified rehearsal fence*, NOT permission to resume a
 * quarantined watch. All v0.11 recovery support remains narrow and offline.
 */
export async function prepareLegacyHostRecovery({
  host, journal, sourceDir, declaredVersion = '0.11.0',
  expectedSourceSnapshotSha256, sourceIdentitySha256,
} = {}) {
  if (!host || !journal ||
      !validSha(expectedSourceSnapshotSha256) ||
      !validSha(sourceIdentitySha256) ||
      host.scopeId !== 'default' ||
      journal.tenantId !== host.tenantId ||
      journal.sourceSnapshotSha256 !== expectedSourceSnapshotSha256 ||
      journal.sourceIdentitySha256 !== sourceIdentitySha256 ||
      typeof host.assertExclusive !== 'function' ||
      typeof host.lookupReceipt !== 'function' ||
      typeof host.attestSource !== 'function' ||
      typeof host.readCheckpoint !== 'function') {
    refuse('RECOVERY_HOST_JOURNAL_BINDING_MISMATCH');
  }
  const binding = { expectedSourceSnapshotSha256, sourceIdentitySha256 };
  await host.assertExclusive(binding);
  const fence = await prepareLegacyReceiptReplayFence({
    sourceDir, declaredVersion, expectedSourceSnapshotSha256,
    runtime: host.runtimeId, tenantId: host.tenantId,
    lookupHostReceipt: input => host.lookupReceipt(input),
    attestProviderSource: input => host.attestSource(input),
    hostGapJournal: journal,
  });
  if (fence.sourceIdentitySha256 !== sourceIdentitySha256) {
    refuse('RECOVERY_HOST_SOURCE_ID_DIGEST_MISMATCH');
  }
  await host.assertExclusive(binding);

  return Object.freeze({
    status: 'runtime-neutral-offline-replay-rehearsal',
    runtimeId: host.runtimeId, tenantId: host.tenantId,
    safeToResumeOrDeploy: false,
    historicalReceiptsReconciled: fence.historicalReceiptsReconciled,
    archivedEventIdsCount: fence.archivedEventIdsCount,
    wrapConnection(connection) {
      const wrapped = fence.wrapConnection(connection);
      return Object.freeze({
        ...wrapped,
        async request(method, ...args) {
          if (typeof method === 'string' && method.startsWith('events/')) {
            await host.assertExclusive(binding);
          }
          try {
            const reply = await wrapped.request(method, ...args);
            if (method === 'events/poll') {
              // An epoch lost DURING the provider RPC must not expose a page
              // to EI. A host must independently enforce its epoch.
              await host.assertExclusive(binding);
            }
            return reply;
          } catch (error) {
            // Any host authority loss after a provider RPC requires a durable
            // failed recovery state, not a checkpointable cursor.
            await journal.block();
            throw error;
          }
        },
      });
    },
    async acknowledgePersistedCheckpoint({ connectionId, eventName, cursor }) {
      await host.assertExclusive(binding);
      return journal.confirmHostCheckpoint({
        cursor,
        checkPersistedCheckpoint: async checkpoint => {
          await host.assertExclusive(binding);
          const durable = await host.readCheckpoint({
            connectionId, eventName, cursor: checkpoint,
          });
          await host.assertExclusive(binding);
          return durable;
        },
      });
    },
    journalStatus: () => journal.status(),
  });
}
