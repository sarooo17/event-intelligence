import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { ExperimentalMcpEventsServer } from '../dist/src/mcpEvents/server.js';
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

async function fixture(kind, fn, { legacyCursor = 'old-cursor' } = {}) {
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
    cursor: legacyCursor, deliveryMode: 'poll',
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
  const makeBridge = ({ authorityOverride, sourceOverride, attestContinuity } = {}) => createLegacyRecoveryHostBridge({
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
        if (attestContinuity) return attestContinuity(evidence);
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

/**
 * Separate durable reference MCP server, actual JSON-RPC over loopback HTTP.
 * No hardcoded poll responses: the existing provider reads persisted SQL
 * rows using its own cursor implementation. This is controlled source
 * evidence, not certification of an independently operated provider.
 */
async function openReferenceProvider(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec('CREATE TABLE IF NOT EXISTS occurrence (sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL)');
  const rows = () => db.prepare('SELECT sequence, body FROM occurrence ORDER BY sequence').all()
    .map(r => ({sequence: Number(r.sequence), serverId: 'fixture-server', event: JSON.parse(r.body)}));
  const provider = new ExperimentalMcpEventsServer({
    latestMcpEventSequence: () => Number(db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS n FROM occurrence').get().n),
    listMcpOccurrencesAfter: sequence => rows().filter(row => row.sequence > sequence),
  });
  provider.registerEvent({
    descriptor: {name: 'fixture.changed', description: 'Reference source',
      delivery: ['poll'], inputSchema: {}, payloadSchema: {type: 'object'}},
    matcher: () => true,
  });
  let calls = 0;
  const http = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const reply = await provider.handleRequest(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify(reply));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const endpoint = 'http://127.0.0.1:' + http.address().port;
  return {
    insert(sequence, event) {
      db.prepare('INSERT INTO occurrence(sequence, event_id, body) VALUES (?, ?, ?)')
        .run(sequence, event.eventId, JSON.stringify(event));
    },
    async attest(evidence) {
      // Verify historical coverage against the source's own durable log.
      // The controlled source is single-writer, append-only within this
      // fixture; it never mutates/deletes/reuses event IDs.
      const cursor = /^mcp-events-v1:(\d+)$/.exec(evidence.legacyCursor);
      const archive = rows();
      if (!cursor || evidence.connectionId !== 'fixture-connection' ||
          evidence.serverId !== 'fixture-server' || evidence.eventName !== 'fixture.changed' ||
          archive.some((r, i) => r.sequence !== i + 1)) return null;
      const prefix = archive.filter(r => r.sequence <= Number(cursor[1]));
      if (prefix.length !== Number(cursor[1]) ||
          prefix.length !== evidence.archivedEventCount ||
          hash(prefix.map(r => r.event.eventId).sort()) !== evidence.archivedEventIdsSha256) return null;
      return {...evidence, stableEventIds: true, immutableEventIdMapping: true,
        cursorPortableToTargetVersion: true, completeReplayThroughLegacyCursor: true,
        noUnreportedGaps: true, supportsPolling: true};
    },
    get calls() { return calls; },
    connection: {
      connectionId: 'fixture-connection', serverId: 'fixture-server',
      async request(method, params) {
        const id = ++calls;
        const response = await fetch(endpoint, {method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({jsonrpc: '2.0', id, method, params})});
        assert.equal(response.status, 200);
        const reply = await response.json();
        assert.equal(reply.id, id);
        if (reply.error) throw new Error('MCP provider refused request');
        return reply.result;
      },
    },
    async close() {
      await new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
}

test('reference MCP server over HTTP + durable SQLite source replays from the old cursor across restart, then reports a gap', async () => {
  await fixture('queue', async ({root, old, bind, journalParams, makeBridge, checkpointFile}) => {
    const dbFile = path.join(root, 'provider.sqlite');
    let provider = await openReferenceProvider(dbFile);
    const prep = async (mode) => {
      const journal = await openLegacyHostGapJournal({...journalParams, mode});
      const host = makeBridge({attestContinuity: evidence => provider.attest(evidence)});
      return prepareLegacyHostRecovery({host, journal, sourceDir: old, ...bind});
    };
    const ack = async (recovery, cursor) => {
      await writeFile(checkpointFile, JSON.stringify({
        connectionId: 'fixture-connection', eventName: 'fixture.changed',
        cursor, committed: true, gapUnresolved: false, truncated: false,
      }));
      await recovery.acknowledgePersistedCheckpoint({
        connectionId: 'fixture-connection', eventName: 'fixture.changed', cursor,
      });
    };
    try {
      provider.insert(1, historicEvent);
      provider.insert(2, freshEvent);
      const recovery = await prep('create');
      const transport = recovery.wrapConnection(provider.connection);
      const descriptors = await transport.request('events/list', {});
      assert.equal(descriptors.events[0].name, 'fixture.changed');
      const page = await transport.request('events/poll', pollArgs);
      assert.deepEqual(page.events.map(e => e.eventId), [freshEvent.eventId]);
      assert.equal(page.cursor, 'mcp-events-v1:2');
      await ack(recovery, page.cursor);
      await provider.close();
      provider = await openReferenceProvider(dbFile);

      const cold = await prep('open');
      const coldTransport = cold.wrapConnection(provider.connection);
      const empty = await coldTransport.request('events/poll', {...pollArgs, cursor: page.cursor});
      assert.deepEqual(empty.events, []);
      await ack(cold, empty.cursor);
      provider.insert(3, {...freshEvent, eventId: 'late-event'});
      // Real reference provider flags maxAgeMs exclusion as truncated.
      await assert.rejects(coldTransport.request('events/poll', {
        ...pollArgs, cursor: empty.cursor, maxAgeMs: 0,
      }), failure('MCP_SOURCE_CONTINUITY_LOST'));
      assert.equal((await cold.journalStatus()).state, 'blocked');
      await provider.close();
      provider = await openReferenceProvider(dbFile);
      await assert.rejects(prep('open'), failure('HOST_GAP_JOURNAL_NOT_READY'));
      assert.equal(provider.calls, 0);
    } finally { await provider.close(); }
  }, {legacyCursor: 'mcp-events-v1:1'});
});

test('durable recovery refuses initial cursor skip and cold-restart cursor substitution before provider RPC', async () => {
  for (const initial of [true, false]) {
    await fixture('workflow', async ({old, journalParams, makeBridge, bind, checkpointFile}) => {
      const journal = await openLegacyHostGapJournal({...journalParams, mode: 'create'});
      const prep = j => prepareLegacyHostRecovery({host: makeBridge(), journal: j, sourceDir: old, ...bind});
      let recovery = await prep(journal);
      const calls = [];
      if (!initial) {
        await recovery.wrapConnection(connection(calls)).request('events/poll', pollArgs);
        await writeFile(checkpointFile, JSON.stringify({
          connectionId: 'fixture-connection', eventName: 'fixture.changed',
          cursor: 'v1-new-checkpoint', committed: true, gapUnresolved: false, truncated: false,
        }));
        await recovery.acknowledgePersistedCheckpoint({
          connectionId: 'fixture-connection', eventName: 'fixture.changed', cursor: 'v1-new-checkpoint',
        });
        recovery = await prep(await openLegacyHostGapJournal({...journalParams, mode: 'open'}));
      }
      const before = calls.length;
      await assert.rejects(recovery.wrapConnection(connection(calls)).request('events/poll', {
        ...pollArgs, cursor: initial ? 'untrusted-future-cursor' : null,
      }), failure('HOST_GAP_JOURNAL_POLL_CURSOR_MISMATCH'));
      assert.equal(calls.length, before);
      assert.equal((await recovery.journalStatus()).state, 'blocked');
    });
  }
});
