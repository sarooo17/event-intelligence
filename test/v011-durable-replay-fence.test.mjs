import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectLegacyJsonlStore } from '../scripts/lib/v011-jsonl-upgrade-preflight.mjs';
import { prepareLegacyReceiptReplayFence } from '../scripts/lib/v011-legacy-receipt-source-fence.mjs';
import { openLegacyHostGapJournal } from '../scripts/lib/v011-host-gap-journal.mjs';

const entry = record => JSON.stringify(record) + '\n';
const code = expected => error => error?.code === expected;
const hash = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const previousEvent = {
  eventId: 'old-event', name: 'fixture.changed',
  timestamp: '2026-10-07T10:00:00.000Z', data: { n: 1 },
};

async function scenario(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-gap-fence-integrated-'));
  const old = path.join(dir, 'old');
  const host = path.join(dir, 'host');
  await mkdir(old);
  await mkdir(host);
  await writeFile(path.join(old, 'triggers.jsonl'), entry({
    triggerId: 'watch', version: '1', conditionOnly: true, withinMs: 60000,
    clauses: [{ id: 'a', serverId: 'fixture', event: 'fixture.changed', arguments: {}, where: [] }],
    pattern: { version: '2', root: { kind: 'event', ref: 'a' } },
  }));
  await writeFile(path.join(old, 'trigger-states.jsonl'), entry({
    triggerId: 'watch', version: '1', status: 'active',
    owner: { type: 'owner', principal_id: 'owner', tenant_id: 'host' },
  }));
  await writeFile(path.join(old, 'wake-deliveries.jsonl'), entry({
    wakeId: 'old-wake', matchId: 'old-match', triggerId: 'watch',
    triggerVersion: '1', runtime: 'muffin',
    status: 'delivered', runtimeReceiptId: 'durable-old-receipt',
  }));
  await writeFile(path.join(old, 'mcp-client-states.jsonl'), entry({
    connectionId: 'fixture-connection', serverId: 'fixture',
    eventName: 'fixture.changed', arguments: {}, subscriptionId: 'internal-poll-id',
    cursor: 'old-source-cursor', deliveryMode: 'poll',
  }));
  await writeFile(path.join(old, 'mcp-events.jsonl'), entry({
    sequence: 1, serverId: 'fixture', subscriptionId: 'internal-poll-id',
    event: previousEvent,
  }));
  const preflight = await inspectLegacyJsonlStore(old, { declaredVersion: '0.11.0' });
  const binding = {
    directory: host,
    sourceSnapshotSha256: preflight.sourceSnapshotSha256,
    sourceIdentitySha256: hash([previousEvent.eventId]), tenantId: 'host',
  };
  const prepare = journal => prepareLegacyReceiptReplayFence({
    sourceDir: old,
    declaredVersion: '0.11.0',
    expectedSourceSnapshotSha256: preflight.sourceSnapshotSha256,
    tenantId: 'host', runtime: 'muffin',
    lookupHostReceipt: async ({ receiptId }) => ({
      receiptId, tenantId: 'host', runtime: 'muffin',
      principalKind: 'system', principalSource: 'automation', state: 'durable',
    }),
    attestProviderSource: async proof => ({
      ...proof,
      stableEventIds: true, immutableEventIdMapping: true,
      cursorPortableToTargetVersion: true,
      completeReplayThroughLegacyCursor: true,
      noUnreportedGaps: true, supportsPolling: true,
    }),
    hostGapJournal: journal,
  });
  const param = { name: 'fixture.changed', arguments: {}, cursor: null };
  const mock = ({ truncated = false } = {}) => ({
    connectionId: 'fixture-connection', serverId: 'fixture',
    request: async method => {
      if (method !== 'events/poll') throw Error('unsupported test call');
      return {
        cursor: 'new-provider-cursor',
        hasMore: false, truncated,
        events: [
          previousEvent,
          {
            eventId: 'new-event', name: 'fixture.changed',
            timestamp: '2026-10-07T11:00:00.000Z', data: { n: 2 },
          },
        ],
      };
    },
  });
  try { await fn({ old, host, binding, prepare, param, mock }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('host journal requires readback of newly persisted v1 cursor before another poll', async () => {
  await scenario(async ({ binding, prepare, param, mock }) => {
    const journal = await openLegacyHostGapJournal({ ...binding, mode: 'create' });
    const fence = await prepare(journal);
    const wrapped = fence.wrapConnection(mock());
    const result = await wrapped.request('events/poll', param);
    assert.deepEqual(result.events.map(x => x.eventId), ['new-event']);
    assert.equal((await journal.status()).state, 'checkpoint-required');

    const cold = await openLegacyHostGapJournal({ ...binding, mode: 'open' });
    await assert.rejects(prepare(cold), code('HOST_GAP_JOURNAL_NOT_READY'));
    await assert.rejects(cold.confirmHostCheckpoint({
      cursor: 'new-provider-cursor',
      checkPersistedCheckpoint: async () => false,
    }), code('HOST_CHECKPOINT_NOT_DURABLE'));

    // Only a concrete host callback that has re-read the committed cursor
    // from its store may confirm. This callback is simulated here: no
    // real provider completeness certification or production cutover.
    await journal.confirmHostCheckpoint({
      cursor: 'new-provider-cursor',
      checkPersistedCheckpoint: async v => v === 'new-provider-cursor',
    });
    const reopened = await openLegacyHostGapJournal({ ...binding, mode: 'open' });
    await reopened.assertReady();
    const next = await prepare(reopened);
    assert.equal(next.safeToResumeOrDeploy, false);
  });
});

test('provider gap is persisted, and a cold restart refuses without new network calls', async () => {
  await scenario(async ({ binding, prepare, param, mock }) => {
    const journal = await openLegacyHostGapJournal({ ...binding, mode: 'create' });
    const fence = await prepare(journal);
    const wrapped = fence.wrapConnection(mock({ truncated: true }));
    await assert.rejects(wrapped.request('events/poll', param),
      code('MCP_SOURCE_CONTINUITY_LOST'));
    assert.equal((await journal.status()).state, 'blocked');

    const cold = await openLegacyHostGapJournal({ ...binding, mode: 'open' });
    await assert.rejects(prepare(cold), code('HOST_GAP_JOURNAL_NOT_READY'));
    await assert.rejects(cold.assertReady(), code('HOST_GAP_JOURNAL_NOT_READY'));
  });
});

test('process dying after durable poll intent but before network response refuses cold restart', async () => {
  await scenario(async ({ binding, prepare }) => {
    const journal = await openLegacyHostGapJournal({ ...binding, mode: 'create' });
    await prepare(journal);
    // This state is written+fsynced BEFORE any transport request.
    await journal.beginPoll({ cursor: 'old-source-cursor' });
    const cold = await openLegacyHostGapJournal({ ...binding, mode: 'open' });
    assert.equal((await cold.status()).state, 'polling');
    await assert.rejects(prepare(cold), code('HOST_GAP_JOURNAL_NOT_READY'));
  });
});

test('old tenant/source journal cannot be re-used for another recovery attempt', async () => {
  await scenario(async ({ binding, prepare }) => {
    const wrong = await openLegacyHostGapJournal({
      ...binding, mode: 'create',
      sourceIdentitySha256: 'a'.repeat(64),
    });
    await assert.rejects(prepare(wrong), code('HOST_GAP_JOURNAL_BINDING_MISMATCH'));
    await assert.rejects(openLegacyHostGapJournal({ ...binding, mode: 'open' }),
      code('HOST_GAP_JOURNAL_INVALID_OR_MISMATCHED'));
  });
});
