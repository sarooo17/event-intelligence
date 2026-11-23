import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { cp, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { inspectLegacyJsonlStore } from '../scripts/lib/v011-jsonl-upgrade-preflight.mjs';
import { prepareLegacyReceiptReplayFence } from '../scripts/lib/v011-legacy-receipt-source-fence.mjs';

const oldRoot = process.env.EI_COMPILED_MUFFIN_011;
const modernRoot = process.env.EI_COMPILED_MUFFIN_100;
const skip = !oldRoot || !modernRoot
  ? 'Requires source-pinned old and v1 compiled Muffin checkouts'
  : false;
const imported = (root, file) => import(pathToFileURL(path.join(root, file)).href);
function context(turnId) {
  return {
    tenant: 'host', principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
    turnId, sessionId: 'owner',
    taint: () => 0, intrinsicTaint: () => 0,
    suspend: () => { throw new Error('unexpected suspend'); },
  };
}
function fixtureConnection() {
  let polls = 0;
  return {
    connectionId: 'demo', serverId: 'demo',
    getCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/events': {} } }),
    request: async method => {
      if (method === 'events/list') return {
        events: [{
          name: 'demo.ready', delivery: ['poll'], inputSchema: { type: 'object' },
          payloadSchema: { type: 'object', properties: { value: { type: 'number' } } },
        }], nextCursor: null,
      };
      if (method === 'events/poll') {
        polls += 1;
        return {
          events: polls <= 2 ? [{
            eventId: 'old-host-turn-store-event',
            name: 'demo.ready',
            timestamp: '2026-10-07T10:00:00.000Z',
            data: { value: 42 },
          }] : [],
          cursor: 'old-muffin-source-' + polls,
          hasMore: false, nextPollMs: 60000,
        };
      }
      throw new Error('unexpected MCP call ' + method);
    },
    pollIntervalMs: 60000,
  };
}

async function hashes(root) {
  const files = [];
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = path.join(prefix, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        files.push([rel, createHash('sha256').update(await readFile(full)).digest('hex')]);
      } else throw new Error('unexpected entry in fixture');
    }
  }
  await walk(root);
  return files.sort(([a], [b]) => a.localeCompare(b));
}

test('compiled Muffin 0.11 actual TurnStore receipt survives cold restart and v1 refusal', {
  skip, timeout: 120000,
}, async () => {
  const { runInit } = await imported(oldRoot, 'dist/cli/init.js');
  const { buildRuntime } = await imported(oldRoot, 'dist/agent/runtime.js');
  const { attachEventIntelligence, getAttachedEventIntelligence } = await imported(
    oldRoot, 'dist/agent/event-intelligence.js');
  const { createMuffinEventIntelligence: createV1 } = await imported(
    modernRoot, 'dist/agent/event-intelligence.js');

  const tmp = mkdtempSync(path.join(tmpdir(), 'ei-compiled-old-muffin-turn-'));
  const home = path.join(tmp, 'original');
  const workspace = path.join(tmp, 'workspace');
  const oldClone = path.join(tmp, 'cold-upgrade-clone');
  let runtime;
  try {
    mkdirSync(workspace);
    runInit({ home, apiKey: 'sk-test-never-executed' });
    runtime = buildRuntime(home, workspace);
    const counters = {
      iterations: 0, recoveriesUsed: 0, transportRetriesLeft: 10,
      truncationsUsed: 0, toolCallsMade: 0, nudgedForCompletion: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      spentUsd: 0, resumes: 0, contextBuilt: true, activeModelMs: 0,
    };
    const source = runtime.deps.turns.create({
      id: 'old-muffin-real-source-turn',
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host', surface: 'cli', sessionId: 'owner',
      providerLease: {
        model: runtime.deps.model,
        checkpoint: [{
          role: 'user', origin: 'owner',
          content: [{ type: 'text', text: 'watch demo.ready' }],
        }],
      },
      taint: 0, counters, replyTo: { channel: 'cli' },
    }, process.pid);

    const attached = await attachEventIntelligence(runtime, [fixtureConnection()], home);
    assert.ok(attached.some(line => line.includes('Events-capable')));
    const create = runtime.deps.tools.find(x => x.spec.name === 'event_watch_create');
    assert.ok(create);
    const result = await create.handler({
      trigger_id: 'old-real-turn-store-watch',
      events: [{ event: 'demo.ready', where: [{ path: 'value', op: 'gt', value: 10 }] }],
      instruction: 'Investigate the synthetic ready event.', one_shot: false,
    }, context(source.id));
    assert.notEqual(result.isError, true, 'real Muffin authority creates legacy watch');
    const embedded = getAttachedEventIntelligence(runtime);
    assert.ok(embedded);
    await embedded.host.runtime.mcpEventsClient.pollAll();
    const due = runtime.deps.turns.due(new Date('2026-10-07T10:01:00.000Z'), 20)
      .filter(x => x.id !== source.id);
    assert.equal(due.length, 1);
    const wake = due[0];
    assert.equal(wake.principal.kind, 'system');
    assert.equal(wake.principal.source, 'automation');
    assert.equal(wake.tenant, 'host');
    assert.equal(wake.taint, 3);
    assert.ok(wake.inputText.includes('Investigate the synthetic ready event.'));
    await embedded.host.runtime.mcpEventsClient.pollAll();
    const dueReplay = runtime.deps.turns.due(new Date('2026-10-07T10:02:00.000Z'), 20)
      .filter(x => x.id !== source.id);
    assert.equal(dueReplay.length, 1);
    assert.equal(dueReplay[0].id, wake.id);

    const receipts = readFileSync(path.join(home, 'event-intelligence',
      'wake-deliveries.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(receipts.at(-1).status, 'delivered');
    assert.equal(receipts.at(-1).runtimeReceiptId, wake.id);
    const oldClientRows = readFileSync(path.join(home, 'event-intelligence',
      'mcp-client-states.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(oldClientRows.some(x =>
      x.connectionId === 'demo' && x.eventName === 'demo.ready' &&
      typeof x.cursor === 'string' && x.cursor.startsWith('old-muffin-source-')),
    'the real old Muffin adapter must leave a durable old source cursor');
    await runtime.close();
    runtime = null;

    const coldOld = buildRuntime(home, workspace);
    assert.equal(coldOld.deps.turns.get(wake.id)?.id, wake.id,
      'Muffin SQLite TurnStore must keep durable old host receipt');
    assert.equal(coldOld.deps.turns.get(wake.id)?.principal?.source, 'automation');

    // Host callback reads the actual reopened Muffin SQLite TurnStore,
    // not a fabricated file-backed receipt. Source replay guarantees below
    // are still synthetic and explicitly host-declared, not independently
    // certified for real-world MCP providers.
    const sourceDir = path.join(home, 'event-intelligence');
    const preflight = await inspectLegacyJsonlStore(sourceDir, {
      declaredVersion: '0.11.0',
    });
    let oldHostReceiptChecks = 0;
    const reconciliation = await prepareLegacyReceiptReplayFence({
      sourceDir,
      expectedSourceSnapshotSha256: preflight.sourceSnapshotSha256,
      declaredVersion: '0.11.0',
      tenantId: 'host',
      runtime: 'muffin',
      lookupHostReceipt: async ({ receiptId }) => {
        oldHostReceiptChecks++;
        const row = coldOld.deps.turns.get(receiptId);
        return row && {
          receiptId: row.id,
          tenantId: row.tenant,
          runtime: 'muffin',
          state: 'durable',
          principalKind: row.principal.kind,
          principalSource: row.principal.source,
        };
      },
      attestProviderSource: async evidence => {
        assert.equal(evidence.legacyCursor, 'old-muffin-source-2');
        assert.equal(evidence.connectionId, 'demo');
        assert.equal(evidence.serverId, 'demo');
        return {
          ...evidence,
          stableEventIds: true,
          cursorPortableToTargetVersion: true,
          immutableEventIdMapping: true,
          completeReplayThroughLegacyCursor: true,
          noUnreportedGaps: true,
          supportsPolling: true,
        };
      },
    });
    assert.equal(oldHostReceiptChecks, 1);
    assert.equal(reconciliation.historicalReceiptsReconciled, 1);
    assert.equal(reconciliation.archivedEventIdsCount, 1);
    assert.equal(reconciliation.safeToResumeOrDeploy, false);
    await coldOld.close();

    const before = await hashes(path.join(home, 'event-intelligence'));
    await cp(home, oldClone, { recursive: true });
    const noDeliveryPort = {
      source: () => null, has: () => false,
      openSession: id => ({ id, file: path.join(oldClone, 'unused.jsonl') }),
      enqueue: () => { throw new Error('No host effect while blocked on old store'); },
    };
    await assert.rejects(
      createV1([fixtureConnection()], oldClone, noDeliveryPort),
      e => e?.code === 'EVENT_INTELLIGENCE_PATTERN_V2_SIGNATURE_INCOMPATIBLE');
    assert.deepEqual(await hashes(path.join(oldClone, 'event-intelligence')), before);
    console.log(JSON.stringify({
      schema: 'ei-muffin-compiled-real-old-turn-store.v1',
      oldAdapterCompiled: true,
      publishedOldPackage: '0.11.0',
      oldRealMuffinSqliteTurnStoreWake: true,
      originalOldWakeReceiptPersistedAndReopened: true,
      originalEventReplayDuplicateHostEffects: 0,
      oldSourceCursorPersisted: true,
      actualSqliteHostReceiptsReconciled: 1,
      providerReplayProofFixtureOnly: true,
      newV1RefusalOnOldHomeClone: true,
      legacyEIRuntimeBytesUnchanged: true,
      losslessRecoveryOrCutoverProven: false,
    }));
  } finally {
    if (runtime) await runtime.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
