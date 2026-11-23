import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectLegacyJsonlStore } from '../scripts/lib/v011-jsonl-upgrade-preflight.mjs';
import { prepareLegacyReceiptReplayFence } from '../scripts/lib/v011-legacy-receipt-source-fence.mjs';

const row = value => JSON.stringify(value) + '\n';
const err = wanted => error => error?.code === wanted;

async function fixture(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ei-v011-receipt-fence-'));
  const old = path.join(home, 'old');
  await mkdir(old);
  const save = (name, value) => writeFile(path.join(old, name), row(value));
  await save('triggers.jsonl', {
    triggerId: 'old-watch', version: '1', conditionOnly: true,
    clauses: [{ id: 'a', event: 'fixture.changed', serverId: 'fixture', where: [], arguments: {} }],
    pattern: { version: '2', root: { kind: 'event', ref: 'a' } }, withinMs: 60000,
  });
  await save('trigger-states.jsonl', {
    triggerId: 'old-watch', version: '1', status: 'active',
    owner: { type: 'owner', principal_id: 'owner', tenant_id: 'host' },
  });
  await save('wake-deliveries.jsonl', {
    wakeId: 'old-wake', matchId: 'old-match', triggerId: 'old-watch',
    triggerVersion: '1', runtime: 'muffin', status: 'delivered',
    runtimeReceiptId: 'old-receipt',
  });
  await save('mcp-client-states.jsonl', {
    connectionId: 'fixture-connection', serverId: 'fixture',
    eventName: 'fixture.changed', arguments: {}, subscriptionId: null,
    deliveryMode: 'poll', cursor: 'cursor-previous',
  });
  await save('mcp-events.jsonl', {
    sequence: 1, serverId: 'fixture', subscriptionId: null,
    event: {
      eventId: 'event-already-delivered', name: 'fixture.changed',
      timestamp: '2026-10-07T10:00:00.000Z', data: { value: 42 },
    },
  });
  const base = {
    sourceDir: old, declaredVersion: '0.11.0',
    runtime: 'muffin', tenantId: 'host',
    lookupHostReceipt: async ({ receiptId }) => ({
      receiptId, tenantId: 'host', runtime: 'muffin', state: 'durable',
      principalKind: 'system', principalSource: 'automation',
    }),
    attestProviderSource: async evidence => ({
      ...evidence,
      stableEventIds: true,
          immutableEventIdMapping: true,
      completeReplayThroughLegacyCursor: true,
      noUnreportedGaps: true,
      supportsPolling: true,
    }),
  };
  const prepare = async override => {
    const report = await inspectLegacyJsonlStore(old, { declaredVersion: '0.11.0' });
    return prepareLegacyReceiptReplayFence({
      ...base,
      expectedSourceSnapshotSha256: report.sourceSnapshotSha256,
      ...override,
    });
  };
  try { await run({ old, base, prepare }); }
  finally { await rm(home, { recursive: true, force: true }); }
}

function pollConnection() {
  return {
    connectionId: 'fixture-connection', serverId: 'fixture',
    request: async method => {
      if (method !== 'events/poll') return { events: [] };
      return {
        cursor: 'new-cursor', hasMore: false, nextPollMs: 60000,
        events: [
          { eventId: 'event-already-delivered', name: 'fixture.changed' },
          { eventId: 'genuinely-new-event', name: 'fixture.changed' },
        ],
      };
    },
  };
}

test('reconciles all old receipts, filters old replay and allows new ID only under external source declaration', async () => {
  await fixture(async ({ old, prepare }) => {
    const bytes = await readFile(path.join(old, 'wake-deliveries.jsonl'));
    let lookups = 0;
    let attestations = 0;
    const boundary = await prepare({
      lookupHostReceipt: async input => {
        lookups++;
        assert.equal(input.receiptId, 'old-receipt');
        assert.equal(input.wakeId, 'old-wake');
        assert.equal(input.tenantId, 'host');
        return {
          receiptId: input.receiptId, tenantId: 'host', runtime: 'muffin',
          state: 'durable', principalKind: 'system', principalSource: 'automation',
        };
      },
      attestProviderSource: async evidence => {
        attestations++;
        assert.equal(evidence.legacyCursor, 'cursor-previous');
        assert.equal(evidence.archivedEventCount, 1);
        assert.match(evidence.archivedEventIdsSha256, /^[0-9a-f]{64}$/);
        return {
          ...evidence, stableEventIds: true,
          immutableEventIdMapping: true,
          completeReplayThroughLegacyCursor: true, noUnreportedGaps: true,
          supportsPolling: true,
        };
      },
    });
    assert.equal(lookups, 1);
    assert.equal(attestations, 1);
    assert.equal(boundary.historicalReceiptsReconciled, 1);
    assert.equal(boundary.archivedEventIdsCount, 1);
    assert.equal(boundary.migrationPerformed, false);
    assert.equal(boundary.safeToResumeOrDeploy, false);
    assert.equal(boundary.productionProviderIndependentlyCertified, false);
    const connection = boundary.wrapConnection(pollConnection());
    const result = await connection.request('events/poll');
    assert.deepEqual(result.events.map(e => e.eventId), ['genuinely-new-event']);
    assert.deepEqual(boundary.replayStats(), { rejectedOld: 1, passedNew: 1 });
    assert.deepEqual(await readFile(path.join(old, 'wake-deliveries.jsonl')), bytes);
  });
});

test('rejects missing host receipt and mismatched principal or tenant', async () => {
  await fixture(async ({ prepare }) => {
    await assert.rejects(prepare({ lookupHostReceipt: async () => null }),
      err('HOST_RECEIPT_MISSING_OR_MISMATCHED'));
    await assert.rejects(prepare({
      lookupHostReceipt: async ({ receiptId }) => ({
        receiptId, tenantId: 'other-tenant', runtime: 'muffin',
        state: 'durable', principalKind: 'owner', principalSource: 'automation',
      }),
    }), err('HOST_RECEIPT_MISSING_OR_MISMATCHED'));
    await assert.rejects(prepare({ tenantId: 'wrong-tenant' }),
      err('HOST_TENANT_REAUTHORIZATION_REQUIRED'));
  });
});

test('rejects provider lacking stable replay proof or complete checkpoint/gap guarantees', async () => {
  await fixture(async ({ prepare }) => {
    await assert.rejects(prepare({ attestProviderSource: async () => null }),
      err('PROVIDER_SOURCE_CONTINUITY_NOT_ATTESTED'));
    await assert.rejects(prepare({
      attestProviderSource: async evidence => ({
        ...evidence, stableEventIds: true,
          immutableEventIdMapping: true,
        completeReplayThroughLegacyCursor: false, noUnreportedGaps: true,
        supportsPolling: true,
      }),
    }), err('PROVIDER_SOURCE_CONTINUITY_NOT_ATTESTED'));
  });
});

test('rejects unsafe polling result and cross-source identity', async () => {
  await fixture(async ({ prepare }) => {
    const f = await prepare();
    assert.throws(() => f.wrapConnection({
      ...pollConnection(), serverId: 'different-server',
    }), err('MCP_CONNECTION_IDENTITY_MISMATCH'));
    await assert.rejects(f.wrapConnection({
      ...pollConnection(),
      request: async () => ({
        cursor: 'cursor', hasMore: false,
        events: [{ name: 'fixture.changed' }],
      }),
    }).request('events/poll'), err('MCP_REPLAY_EVENT_IDENTITY_AMBIGUOUS'));
    await assert.rejects(f.wrapConnection({
      ...pollConnection(),
      request: async () => ({ cursor: undefined, hasMore: false, events: [] }),
    }).request('events/poll'), err('MCP_POLL_RESULT_AMBIGUOUS'));
  });
});

test('source snapshot change during provider attestation fails closed', async () => {
  await fixture(async ({ old, prepare }) => {
    await assert.rejects(prepare({
      attestProviderSource: async evidence => {
        await appendFile(path.join(old, 'mcp-events.jsonl'), row({
          sequence: 2, serverId: 'fixture', subscriptionId: null,
          event: { eventId: 'late-id', name: 'fixture.changed' },
        }));
        return {
          ...evidence, stableEventIds: true,
          immutableEventIdMapping: true,
          completeReplayThroughLegacyCursor: true, noUnreportedGaps: true,
          supportsPolling: true,
        };
      },
    }), err('SOURCE_SNAPSHOT_CHANGED'));
  });
});

test('refuses partial archive, in-flight old wake and ambiguous source cursors', async () => {
  await fixture(async ({ old, prepare }) => {
    await writeFile(path.join(old, 'mcp-events.jsonl'), '');
    await assert.rejects(prepare(), err('SOURCE_ARCHIVE_INCOMPLETE_OR_OVERSIZED'));
    await writeFile(path.join(old, 'mcp-events.jsonl'), row({
      sequence: 1, serverId: 'fixture', subscriptionId: null,
      event: { eventId: 'event-already-delivered', name: 'fixture.changed' },
    }));
    await appendFile(path.join(old, 'wake-deliveries.jsonl'), row({
      wakeId: 'inflight-wake', matchId: 'match-pending',
      triggerId: 'old-watch', triggerVersion: '1',
      runtime: 'muffin', status: 'claimed',
    }));
    await assert.rejects(prepare(), err('LEGACY_STATE_NOT_RECONCILABLE'));
  });
});
