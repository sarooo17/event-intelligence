import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createLegacyRecoveryHostBridge,
  openLegacyHostGapJournal,
  prepareLegacyHostRecovery,
} from '../scripts/legacy-recovery-host.mjs';
import { inspectLegacyJsonlStore } from '../scripts/lib/v011-jsonl-upgrade-preflight.mjs';

const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const asLine = v => JSON.stringify(v) + '\n';
const failure = code => e => e?.code === code;
const historicEvent = {
  eventId: 'existing-event', name: 'fixture.changed',
  timestamp: '2026-10-05T09:00:00.000Z', data: { count: 17 },
};
const freshEvent = {
  eventId: 'genuine-new-event', name: 'fixture.changed',
  timestamp: '2026-10-05T09:10:00.000Z', data: { count: 18 },
};

async function fixture(kind, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ei-host-neutral-legacy-'));
  const old = path.join(root, 'old-ei');
  const hostDir = path.join(root, 'host-recovery-journal');
  await mkdir(old);
  await mkdir(hostDir);
  const runtimeId = kind === 'queue' ? 'queue-runner' : 'workflow-orchestrator';
  const tenantId = kind === 'queue' ? 'tenant-q' : 'tenant-w';
  const receiptId = kind === 'queue' ? 'queue-job-id-26' : 'workflow-checkpoint-id-17';
  const receipt = {
    wakeId: 'old-wake', matchId: 'old-match', triggerId: 'old-watch',
    triggerVersion: '1', runtime: runtimeId,
    status: 'delivered', runtimeReceiptId: receiptId,
  };
  await writeFile(path.join(old, 'triggers.jsonl'), asLine({
    triggerId: 'old-watch', version: '1', conditionOnly: true, withinMs: 60000,
    clauses: [{
      id: 'a', serverId: 'fixture-server', event: 'fixture.changed',
      arguments: {}, where: [],
    }],
    pattern: { version: '2', root: { kind: 'event', ref: 'a' } },
  }));
  await writeFile(path.join(old, 'trigger-states.jsonl'), asLine({
    triggerId: 'old-watch', version: '1', status: 'active',
    owner: { type: 'owner', principal_id: 'owner', tenant_id: tenantId },
  }));
  await writeFile(path.join(old, 'wake-deliveries.jsonl'), asLine(receipt));
  await writeFile(path.join(old, 'mcp-client-states.jsonl'), asLine({
    connectionId: 'fixture-connection', serverId: 'fixture-server',
    eventName: 'fixture.changed', arguments: {}, subscriptionId: 'poll-sub',
    cursor: 'old-cursor', deliveryMode: 'poll',
  }));
  await writeFile(path.join(old, 'mcp-events.jsonl'), asLine({
    sequence: 1, serverId: 'fixture-server', subscriptionId: 'poll-sub',
    event: historicEvent,
  }));
  const epochFile = path.join(root, 'host-lease.json');
  const receiptFile = path.join(root, 'host-receipts.json');
  const checkpointFile = path.join(root, 'host-source-checkpoint.json');
  await writeFile(epochFile, JSON.stringify({epoch: 'exclusive-epoch-1', owner: 'this-host', exclusive: true}));
  const queueFormat = { durableJobs: [{jobId: receiptId, wakeId: 'old-wake', tenant: tenantId, origin: 'automation'}] };
  const workflowFormat = { checkpoints: { [receiptId]: {taskWake: 'old-wake', namespace: tenantId, principal: 'system:automation'} } };
  await writeFile(receiptFile, JSON.stringify(kind === 'queue' ? queueFormat : workflowFormat));
  const inspect = await inspectLegacyJsonlStore(old, { declaredVersion: '0.11.0' });
  const bind = {
    expectedSourceSnapshotSha256: inspect.sourceSnapshotSha256,
    sourceIdentitySha256: hash([historicEvent.eventId]),
  };
  const journalParams = {
    directory: hostDir, tenantId, sourceSnapshotSha256: bind.expectedSourceSnapshotSha256,
    sourceIdentitySha256: bind.sourceIdentitySha256,
    authorityEpoch: 'exclusive-epoch-1',
  };
  const makeBridge = ({ authorityOverride, sourceOverride } = {}) => createLegacyRecoveryHostBridge({
    runtimeId, tenantId,
    authority: {
      async assertExclusive(input) {
        const lease = JSON.parse(await readFile(epochFile, 'utf8'));
        const proof = {
          exclusive: lease.exclusive,
          runtimeId: input.runtimeId, tenantId: input.tenantId,
          scopeId: input.scopeId, epoch: lease.epoch,
          sourceSnapshotSha256: input.sourceSnapshotSha256,
          sourceIdentitySha256: input.sourceIdentitySha256,
        };
        return authorityOverride ? authorityOverride(proof) : proof;
      },
    },
    receipts: {
      async lookup(request) {
        const raw = JSON.parse(await readFile(receiptFile, 'utf8'));
        if (kind === 'queue') {
          const item = raw.durableJobs.find(x => x.jobId === request.receiptId);
          return item && {
            receiptId: item.jobId, wakeId: item.wakeId,
            runtimeId, tenantId: item.tenant, scopeId: 'default',
            state: 'durable', principalKind: 'system',
            principalSource: item.origin,
          };
        }
        const item = raw.checkpoints[request.receiptId];
        return item && {
          receiptId: request.receiptId, wakeId: item.taskWake,
          runtimeId, tenantId: item.namespace, scopeId: 'default',
          state: 'durable', principalKind: item.principal.split(':')[0],
          principalSource: item.principal.split(':')[1],
        };
      },
    },
    source: {
      async attestContinuity(evidence) {
        const proof = {
          ...evidence, stableEventIds: true,
          immutableEventIdMapping: true,
          cursorPortableToTargetVersion: true,
          completeReplayThroughLegacyCursor: true,
          noUnreportedGaps: true, supportsPolling: true,
        };
        return sourceOverride ? sourceOverride(proof) : proof;
      },
    },
    checkpoints: {
      async readDurable(request) {
        let raw;
        try { raw = JSON.parse(await readFile(checkpointFile, 'utf8')); }
        catch { return null; }
        return {
          runtimeId, tenantId, scopeId: 'default',
          connectionId: raw.connectionId, eventName: raw.eventName,
          cursor: raw.cursor,
          durable: raw.committed === true, gapUnresolved: raw.gapUnresolved,
          truncated: raw.truncated,
        };
      },
    },
  });
  try { await fn({ root, old, hostDir, runtimeId, tenantId, receiptFile,
    epochFile, checkpointFile, journalParams, bind, makeBridge }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

const pollArgs = { name: 'fixture.changed', arguments: {}, cursor: null };
function connection(log) {
  return {
    connectionId: 'fixture-connection', serverId: 'fixture-server',
    async request(method, args) {
      if (method !== 'events/poll') throw Error('unexpected event transport');
      log.push(args.cursor);
      return {
        cursor: 'v1-new-checkpoint', hasMore: false,
        events: [historicEvent, freshEvent], nextPollMs: 60000,
      };
    },
  };
}

for (const kind of ['queue', 'workflow']) {
  test(`one neutral recovery contract works with ${kind} host storage and cold checkpoint restart`, async () => {
    await fixture(kind, async ({ old, journalParams, makeBridge, bind, checkpointFile }) => {
      const bridge = makeBridge();
      const exclusive = await bridge.assertExclusive(bind);
      assert.equal(exclusive, 'exclusive-epoch-1');
      const journal = await openLegacyHostGapJournal({ ...journalParams, mode: 'create' });
      const rehearsal = await prepareLegacyHostRecovery({
        host: bridge, journal, sourceDir: old, ...bind,
      });
      assert.equal(rehearsal.runtimeId, kind === 'queue' ? 'queue-runner' : 'workflow-orchestrator');
      assert.equal(rehearsal.safeToResumeOrDeploy, false);
      assert.equal(rehearsal.historicalReceiptsReconciled, 1);
      assert.equal(rehearsal.archivedEventIdsCount, 1);
      const cursors = [];
      const transport = rehearsal.wrapConnection(connection(cursors));
      const page = await transport.request('events/poll', pollArgs);
      assert.deepEqual(cursors, ['old-cursor']);
      assert.deepEqual(page.events.map(e => e.eventId), [freshEvent.eventId]);
      assert.equal((await journal.status()).state, 'checkpoint-required');
      await assert.rejects(rehearsal.acknowledgePersistedCheckpoint({
        connectionId: 'another-source', eventName: 'fixture.changed',
        cursor: 'v1-new-checkpoint',
      }), failure('RECOVERY_HOST_CHECKPOINT_SOURCE_MISMATCH'));
      await assert.rejects(rehearsal.acknowledgePersistedCheckpoint({
        connectionId: 'fixture-connection', eventName: 'another-event',
        cursor: 'v1-new-checkpoint',
      }), failure('RECOVERY_HOST_CHECKPOINT_SOURCE_MISMATCH'));
      await assert.rejects(rehearsal.acknowledgePersistedCheckpoint({
        connectionId: 'fixture-connection', eventName: 'fixture.changed',
        cursor: 'v1-new-checkpoint',
      }), failure('HOST_CHECKPOINT_NOT_DURABLE'));
      await writeFile(checkpointFile, JSON.stringify({
        connectionId: 'fixture-connection', eventName: 'fixture.changed',
        cursor: 'v1-new-checkpoint', committed: true,
        truncated: false, gapUnresolved: false,
      }));
      await rehearsal.acknowledgePersistedCheckpoint({
        connectionId: 'fixture-connection', eventName: 'fixture.changed',
        cursor: 'v1-new-checkpoint',
      });
      const reopenedJournal = await openLegacyHostGapJournal({
        ...journalParams, mode: 'open',
      });
      const coldBridge = makeBridge();
      const cold = await prepareLegacyHostRecovery({
        host: coldBridge, journal: reopenedJournal,
        sourceDir: old, ...bind,
      });
      assert.equal(cold.safeToResumeOrDeploy, false);
      await reopenedJournal.assertReady();
    });
  });

  test(`${kind} host epoch theft refuses old writer and journal reuse on cold restart`, async () => {
    await fixture(kind, async ({ old, journalParams, makeBridge, bind, epochFile }) => {
      const original = makeBridge();
      await original.assertExclusive(bind);
      const journal = await openLegacyHostGapJournal({
        ...journalParams, mode: 'create',
      });
      const originalSession = await prepareLegacyHostRecovery({
        host: original, journal, sourceDir: old, ...bind,
      });
      await writeFile(epochFile, JSON.stringify({
        exclusive: true, epoch: 'exclusive-epoch-2', owner: 'other-host',
      }));
      let providerCalls = 0;
      const wire = originalSession.wrapConnection({
        ...connection([]),
        request: async () => { providerCalls++; throw Error('must not poll'); },
      });
      await assert.rejects(wire.request('events/poll', pollArgs),
        failure('RECOVERY_HOST_EPOCH_CHANGED'));
      assert.equal(providerCalls, 0);
      const cold = makeBridge();
      await assert.rejects(prepareLegacyHostRecovery({
        host: cold, journal: await openLegacyHostGapJournal({
          ...journalParams, mode: 'open',
        }),
        sourceDir: old, ...bind,
      }), failure('RECOVERY_HOST_JOURNAL_EPOCH_MISMATCH'));
    });
  });
}

test('portable host contract rejects absent capabilities, mismatched receipts and false exclusive epochs', async () => {
  await fixture('queue', async ({ old, journalParams, bind, makeBridge, receiptFile }) => {
    assert.throws(() => createLegacyRecoveryHostBridge({
      runtimeId: 'queue-runner', tenantId: 'tenant-q',
      authority: {}, receipts: {}, source: {}, checkpoints: {},
    }), failure('RECOVERY_HOST_CAPABILITY_REQUIRED'));
    const first = makeBridge();
    await first.assertExclusive(bind);
    const journal = await openLegacyHostGapJournal({ ...journalParams, mode: 'create' });
    await writeFile(receiptFile, JSON.stringify({ durableJobs: [] }));
    await assert.rejects(prepareLegacyHostRecovery({
      host: first, journal, sourceDir: old, ...bind,
    }), failure('RECOVERY_HOST_DURABLE_RECEIPT_MISMATCH'));
  });
});

test('portable bridge rejects stale source attestations and unbound lease snapshot proofs', async () => {
  await fixture('workflow', async ({ old, journalParams, bind, makeBridge }) => {
    const wrongLease = makeBridge({
      authorityOverride: proof => ({
        ...proof, sourceSnapshotSha256: 'f'.repeat(64),
      }),
    });
    await assert.rejects(wrongLease.assertExclusive(bind),
      failure('RECOVERY_HOST_EXCLUSIVE_EPOCH_REQUIRED'));

    for (const bad of [
      { tenantId: 'another-tenant' },
      { runtimeId: 'another-runtime' },
      { scopeId: 'another-scope' },
      { epoch: 'stale-lease-epoch' },
    ]) {
      const forged = makeBridge({
        sourceOverride: proof => ({ ...proof, ...bad }),
      });
      await forged.assertExclusive(bind);
      const journal = await openLegacyHostGapJournal({
        ...journalParams,
        mode: 'open',
      }).catch(async e => e?.code === 'HOST_GAP_JOURNAL_MISSING'
        ? openLegacyHostGapJournal({ ...journalParams, mode: 'create' })
        : Promise.reject(e));
      await assert.rejects(prepareLegacyHostRecovery({
        host: forged, journal, sourceDir: old, ...bind,
      }), failure('RECOVERY_HOST_SOURCE_AUTHORITY_MISMATCH'));
    }
  });
});
