import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCompositeTriggerDefinition } from '../../dist/src/intelligenceProtocol/index.js';
import { PersistentEventStore } from './persistent-event-store.mjs';
import {
  inspectLegacyJsonlStore,
  LegacyJsonlPreflightError,
} from './v011-jsonl-upgrade-preflight.mjs';

/**
 * Stage a SEPARATE paused-only v1 store after explicit host reauthorization.
 *
 * This is *not* a lossless historical migration. Do NOT direct traffic to this
 * quarantine candidate or resume it: source cursors, event-time candidates,
 * old wake identities and receipts are deliberately NOT imported. A separate
 * host E2E replay/idempotency protocol must authorize any later cutover.
 */
const refuse = code => { throw new LegacyJsonlPreflightError(code); };

async function activeDefinitions(sourceDir, scopeId) {
  const folder = scopeId === 'default' ? sourceDir
    : path.join(sourceDir, 'scopes',
      Buffer.from(scopeId, 'utf8').toString('base64url'));
  const readRows = async name => {
    let raw;
    try { raw = await readFile(path.join(folder, name), 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  const triggers = await readRows('triggers.jsonl');
  const stateRows = await readRows('trigger-states.jsonl');
  const states = new Map(stateRows.map(x =>
    [JSON.stringify([x.triggerId, x.version]), x]));
  return triggers.filter(x => {
    const state = states.get(JSON.stringify([x.triggerId, x.version]));
    return ['active', 'paused'].includes(state?.status ?? 'active');
  }).map(definition => ({
    definition: parseCompositeTriggerDefinition(definition),
    legacyOwner: states.get(JSON.stringify([
      definition.triggerId, definition.version,
    ]))?.owner ?? null,
  }));
}

function validAuthority(value) {
  return value && typeof value === 'object' &&
    typeof value.type === 'string' && value.type.trim() &&
    typeof value.principal_id === 'string' && value.principal_id.trim();
}

export async function stageLegacyWatchesPaused({
  sourceDir,
  targetDir,
  expectedSourceSnapshotSha256,
  authorizeWatch,
  declaredVersion,
} = {}) {
  if (!sourceDir || !targetDir || typeof authorizeWatch !== 'function') {
    refuse('EXPLICIT_DESTINATION_AND_HOST_AUTHORIZATION_REQUIRED');
  }
  if (typeof expectedSourceSnapshotSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expectedSourceSnapshotSha256)) {
    refuse('SOURCE_SNAPSHOT_DIGEST_REQUIRED');
  }
  const source = await realpath(sourceDir);
  const parent = await realpath(path.dirname(path.resolve(targetDir)));
  const dest = path.join(parent, path.basename(path.resolve(targetDir)));
  if (dest === source || dest.startsWith(source + path.sep) ||
      source.startsWith(dest + path.sep)) {
    refuse('SOURCE_TARGET_OVERLAP');
  }

  const preflight = await inspectLegacyJsonlStore(source, { declaredVersion });
  if (preflight.sourceSnapshotSha256 !== expectedSourceSnapshotSha256) {
    refuse('SOURCE_SNAPSHOT_CHANGED');
  }
  for (const item of preflight.scopes) {
    const c = item.counts;
    if (c.pendingDeadlines !== 0) refuse('PENDING_DEADLINE_RECONCILIATION_REQUIRED');
    if (c.missingWatchOwner !== 0 || c.invalidDeliveredReceipts !== 0 ||
        c.inFlightDeliveries !== 0 ||
        c.latestDeliveries !== c.deliveredReceipts ||
        c.activeOrPausedWatches !== c.v1SchemaCompatibleWatches) {
      refuse('UNSAFE_LEGACY_WATCH_OR_RECEIPT_STATE');
    }
  }
  const plans = [];
  for (const item of preflight.scopes) {
    for (const watch of await activeDefinitions(source, item.scope)) {
      // Explicit host policy must make a fresh owner decision. Never copy an
      // old identity into v1 as an authorization by itself.
      const approval = await authorizeWatch({
        scopeId: item.scope,
        legacyOwner: structuredClone(watch.legacyOwner),
        definition: structuredClone(watch.definition),
      });
      if (!approval || !validAuthority(approval.owner) ||
          !validAuthority(approval.actor) || approval.owner.type !== 'owner') {
        refuse('HOST_REAUTHORIZATION_DENIED');
      }
      // Owner identity may be reauthorized by the host; do not allow a
      // tenant reassignment as a side effect of watch recreation.
      const oldTenant = watch.legacyOwner?.tenant_id;
      const newTenant = approval.owner.tenant_id;
      if ((oldTenant !== undefined && oldTenant !== newTenant) ||
          approval.actor.tenant_id !== newTenant ||
          (newTenant !== undefined && (typeof newTenant !== 'string' || !newTenant.trim()))) {
        refuse('HOST_REAUTHORIZATION_TENANT_MISMATCH');
      }
      plans.push({
        scopeId: item.scope, definition: watch.definition,
        owner: structuredClone(approval.owner),
        actor: structuredClone(approval.actor),
      });
    }
  }
  if (!plans.length) refuse('NO_ACTIVE_WATCHES_TO_STAGE');

  // Check again after potentially asynchronous host authorization. There is
  // no OS lock; caller MUST fence every old writer before taking the snapshot.
  const verified = await inspectLegacyJsonlStore(source, { declaredVersion });
  if (verified.sourceSnapshotSha256 !== expectedSourceSnapshotSha256) {
    refuse('SOURCE_SNAPSHOT_CHANGED');
  }

  // Exclusive create; never operate on an existing target or published
  // v1 store. A failure removes only our own newly created candidate.
  await mkdir(dest, { recursive: false, mode: 0o700 });
  let store;
  const scopes = [];
  try {
    store = new PersistentEventStore(dest);
    await store.init();
    const scoped = new Map([['default', store]]);
    for (const plan of plans) {
      let current = scoped.get(plan.scopeId);
      if (!current) {
        current = await store.forScope(plan.scopeId);
        scoped.set(plan.scopeId, current);
      }
      // Crash boundary: a definition with no state defaults to active in
      // PersistentEventStore. Persist PAUSED before exposing the definition.
      // If killed here, a lone paused state has no executable trigger; if
      // killed after putTrigger, the trigger is already paused on reopen.
      await current.setTriggerState(
        plan.definition.triggerId,
        plan.definition.version,
        'paused',
        plan.actor,
        { owner: plan.owner, connectionIds: [] },
      );
      await current.putTrigger(plan.definition);
    }
    for (const entry of scoped.values()) {
      if (entry !== store) scopes.push(entry);
    }
    const postCheck = await inspectLegacyJsonlStore(source, { declaredVersion });
    if (postCheck.sourceSnapshotSha256 !== expectedSourceSnapshotSha256) {
      refuse('SOURCE_SNAPSHOT_CHANGED');
    }
    // The published v1 store ignores this manifest; its value is operator
    // evidence only. The paused state is the actual v1 safety boundary.
    const manifest = {
      schema: 'ei-v011-paused-recovery-candidate.v1',
      status: 'quarantined-paused-not-cutover-ready',
      sourceVersionDeclared: declaredVersion,
      sourceSnapshotSha256: expectedSourceSnapshotSha256,
      stagedWatches: plans.length,
      originalDeliveredReceipts: preflight.scopes.reduce(
        (sum, item) => sum + item.counts.deliveredReceipts, 0),
      sourceCursorImported: false,
      oldReceiptsImported: false,
      oldPatternHistoryImported: false,
      oldTemporalDeadlinesImported: false,
      pendingLegacyDeadlines: 0,
      oldMcpEventsImported: false,
      allWatchesPaused: true,
      hostReauthorizationWasCallbackBased: true,
      safeToResumeOrDeploy: false,
    };
    await writeFile(path.join(dest, 'legacy-recovery-quarantine.json'),
      JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return manifest;
  } catch (error) {
    await rm(dest, { recursive: true, force: true });
    throw error;
  } finally {
    for (const item of scopes) await item.close();
    await store?.close();
  }
}
