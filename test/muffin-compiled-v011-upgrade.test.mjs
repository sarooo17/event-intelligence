import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { cp, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { inspectLegacyJsonlStore } from '../scripts/lib/v011-jsonl-upgrade-preflight.mjs';
import { stageLegacyWatchesPaused } from '../scripts/lib/v011-jsonl-paused-recovery.mjs';

const oldRoot = process.env.EI_COMPILED_MUFFIN_011;
const modernRoot = process.env.EI_COMPILED_MUFFIN_100;
const skip = !oldRoot || !modernRoot
  ? 'Requires two real compiled Muffin source checkouts and pinned published EI dependencies'
  : false;

const pathFor = (root, rel) => pathToFileURL(path.join(root, rel)).href;
const toolContext = (turnId = 'original-owner-turn') => ({
  tenant: 'host',
  principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
  turnId,
  sessionId: 'original-owner-session',
  taint: () => 0,
  intrinsicTaint: () => 0,
  suspend: () => { throw new Error('unexpected tool suspension'); },
});

async function snapshot(base) {
  const files = [];
  async function walk(dir, prefix = '') {
    for (const item of (await readdir(dir, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(prefix, item.name);
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full, name);
      else if (item.isFile()) {
        files.push([name, createHash('sha256').update(await readFile(full)).digest('hex')]);
      } else throw new Error('Unexpected source entry');
    }
  }
  await walk(base);
  return files;
}

const fixtureSource = {
  id: 'original-owner-turn',
  tenant: 'host',
  surface: 'telegram',
  sessionId: 'original-owner-session',
  replyTo: { chatId: 'synthetic-room' },
  principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
};

function durableHostPort(home) {
  const ledgerPath = path.join(home, 'host-delivered-receipts.jsonl');
  const saved = new Map();
  if (existsSync(ledgerPath)) {
    for (const line of readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)) {
      const receipt = JSON.parse(line);
      saved.set(receipt.id, receipt);
    }
  }
  const attempts = [];
  return {
    attempts,
    saved,
    source: id => id === fixtureSource.id ? fixtureSource : null,
    has: id => saved.has(id),
    openSession: id => ({ id, file: path.join(home, id + '.jsonl') }),
    enqueue: (input, wakeId) => {
      assert.equal(input.principal.kind, 'system');
      assert.equal(input.principal.source, 'automation');
      const id = input.id;
      if (typeof id !== 'string' || !id) throw new Error('missing host Turn receipt identity');
      attempts.push({ id, wakeId: wakeId ?? null });
      if (saved.has(id)) return id;
      // Synthetic host ledger, backed by real files, not a Muffin TurnStore.
      // We intentionally do not claim this substitutes for its actual SQLite
      // host side-effect reconciliation or an authorized live migration.
      const record = { id, wakeId: wakeId ?? null, tenant: input.tenant, status: 'delivered' };
      appendFileSync(ledgerPath, JSON.stringify(record) + '\n', { encoding: 'utf8', flag: 'a' });
      saved.set(id, record);
      return id;
    },
  };
}

function syntheticConnection(events) {
  let polled = false;
  return {
    connectionId: 'fixture-connection',
    serverId: 'fixture',
    getCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/events': {} } }),
    request: async (method) => {
      if (method === 'events/list') return {
        events: [{
          name: 'fixture.changed',
          delivery: ['poll'],
          inputSchema: { type: 'object' },
          payloadSchema: { type: 'object', properties: { value: { type: 'number' } } },
        }],
        nextCursor: null,
      };
      if (method === 'events/poll') {
        const seen = polled;
        polled = true;
        return {
          events: seen ? [] : events,
          cursor: seen ? 'fixture-end' : 'fixture-first',
          hasMore: false,
          nextPollMs: 60000,
        };
      }
      throw new Error('unsupported fixture MCP method ' + method);
    },
    pollIntervalMs: 60000,
  };
}

test('real compiled old Muffin+published EI 0.11 watch, host receipt and paused v1 rebuild', {
  skip,
  timeout: 120000,
}, async () => {
  const oldPackage = JSON.parse(readFileSync(path.join(oldRoot,
    'node_modules/mcp-event-intelligence/package.json'), 'utf8'));
  const modernPackage = JSON.parse(readFileSync(path.join(modernRoot,
    'node_modules/mcp-event-intelligence/package.json'), 'utf8'));
  assert.equal(oldPackage.version, '0.11.0');
  assert.equal(modernPackage.version, '1.0.0');
  const { createMuffinEventIntelligence: createOld } = await import(
    pathFor(oldRoot, 'dist/agent/event-intelligence.js'));
  const { createMuffinEventIntelligence: createV1 } = await import(
    pathFor(modernRoot, 'dist/agent/event-intelligence.js'));
  const { PersistentEventStore: OldStore } = await import(
    pathFor(oldRoot, 'node_modules/mcp-event-intelligence/scripts/lib/persistent-event-store.mjs'));

  const temp = mkdtempSync(path.join(tmpdir(), 'ei-muffin-compiled-old-'));
  const original = path.join(temp, 'original-home');
  const upgradeClone = path.join(temp, 'old-copied-home');
  const candidateHome = path.join(temp, 'candidate-home');

  try {
    mkdirSync(candidateHome);
    const oldPort = durableHostPort(original);
    const firstEvent = {
      eventId: 'original-delivered-occurrence', name: 'fixture.changed',
      timestamp: '2026-10-02T20:00:00.000Z', data: { value: 42 },
    };
    const old = await createOld([syntheticConnection([firstEvent])], original, oldPort);
    const create = old.toolCatalog.get('event_watch_create');
    assert.ok(create, 'old compiled Muffin exposes owner-scoped watch creation');
    const armed = await create.execute({
      trigger_id: 'compiled-old-muffin-watch',
      events: [{ event: 'fixture.changed', where: [{ path: 'value', op: 'gt', value: 10 }] }],
      instruction: 'Inspect my synthetic event.',
      one_shot: false,
    }, toolContext());
    assert.equal(armed.ok, true, JSON.stringify(armed.error ?? null));
    const list = old.toolCatalog.get('event_watch_list');
    assert.ok(list);
    const listed = await list.execute({ limit: 20 }, toolContext());
    assert.equal(listed.ok, true);
    await old.host.runtime.mcpEventsClient.pollAll();
    assert.equal(oldPort.attempts.length, 1, 'real old Muffin adapter must enqueue exactly one Turn');
    const oldHostReceipt = oldPort.attempts[0].id;
    assert.equal(oldPort.saved.size, 1);
    await old.close();

    const oldStoreDir = path.join(original, 'event-intelligence');
    const reopened = new OldStore(oldStoreDir);
    await reopened.init();
    assert.equal(reopened.listTriggers().length, 1);
    // The old SDK's actual receipt remains the authoritative evidence.
    const deliveryFile = path.join(oldStoreDir, 'wake-deliveries.jsonl');
    const deliveryRows = readFileSync(deliveryFile, 'utf8').trim().split('\n').map(JSON.parse);
    const finalDelivery = deliveryRows.at(-1);
    assert.equal(finalDelivery.status, 'delivered');
    assert.equal(finalDelivery.runtimeReceiptId, oldHostReceipt);
    await reopened.close();

    const oldReadOnlyBefore = await snapshot(oldStoreDir);
    await cp(original, upgradeClone, { recursive: true });
    const v1Port = durableHostPort(upgradeClone);
    await assert.rejects(
      createV1([syntheticConnection([])], upgradeClone, v1Port),
      error => error?.code === 'EVENT_INTELLIGENCE_PATTERN_V2_SIGNATURE_INCOMPATIBLE',
    );
    assert.equal(v1Port.attempts.length, 0);
    assert.deepEqual(await snapshot(path.join(upgradeClone, 'event-intelligence')), oldReadOnlyBefore);
    assert.equal(durableHostPort(original).saved.has(oldHostReceipt), true);
    assert.equal(durableHostPort(upgradeClone).saved.has(oldHostReceipt), true);

    const report = await inspectLegacyJsonlStore(oldStoreDir, { declaredVersion: '0.11.0' });
    const staged = await stageLegacyWatchesPaused({
      sourceDir: oldStoreDir,
      targetDir: path.join(candidateHome, 'event-intelligence'),
      declaredVersion: '0.11.0',
      expectedSourceSnapshotSha256: report.sourceSnapshotSha256,
      authorizeWatch: async ({ scopeId, legacyOwner, definition }) => {
        assert.equal(scopeId, 'default');
        assert.ok(legacyOwner);
        assert.equal(definition.triggerId, 'compiled-old-muffin-watch');
        return {
          owner: { type: 'owner', principal_id: 'muffin:synthetic-reauthorized', tenant_id: 'host' },
          actor: { type: 'agent', principal_id: 'muffin:event-intelligence', tenant_id: 'host' },
        };
      },
    });
    assert.equal(staged.stagedWatches, 1);
    assert.equal(staged.originalDeliveredReceipts, 1);
    assert.equal(staged.safeToResumeOrDeploy, false);
    assert.equal(staged.oldReceiptsImported, false);
    assert.deepEqual(await snapshot(oldStoreDir), oldReadOnlyBefore);

    const candidatePort = durableHostPort(candidateHome);
    const candidate = await createV1([syntheticConnection([firstEvent])],
      candidateHome, candidatePort);
    try {
      const stateRows = readFileSync(path.join(candidateHome, 'event-intelligence',
        'trigger-states.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(stateRows.at(-1).status, 'paused');
      await candidate.host.runtime.mcpEventsClient.pollAll();
      assert.equal(candidatePort.attempts.length, 0,
        'quarantined watch MUST NOT redispatch historical occurrence');
      const tools = candidate.toolCatalog;
      const listedCandidate = await tools.get('event_watch_list').execute(
        { limit: 20 }, toolContext());
      assert.equal(listedCandidate.ok, true);
    } finally {
      await candidate.close();
    }

    const secondPort = durableHostPort(candidateHome);
    const restart = await createV1([syntheticConnection([firstEvent])],
      candidateHome, secondPort);
    try {
      await restart.host.runtime.mcpEventsClient.pollAll();
      assert.equal(secondPort.attempts.length, 0, 'candidate remains paused on second restart');
    } finally {
      await restart.close();
    }

    console.log(JSON.stringify({
      schema: 'ei-muffin-compiled-legacy-quarantine.v1',
      publishedOldSdk: oldPackage.version,
      publishedNewSdk: modernPackage.version,
      oldCompiledMuffinWatchCreated: true,
      oldActualWakeAndHostDiskReceiptDelivered: true,
      oldHostReceiptColdReopened: true,
      v1InPlaceRefusalAndUnmodifiedClone: true,
      independentV1CandidatePaused: true,
      historicalReplayWhilePausedExternalEffects: 0,
      secondRestartWhilePausedExternalEffects: 0,
      losslessMigrationVerified: false,
      newWakeAfterAuthorizedCutoverVerified: false,
    }));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
