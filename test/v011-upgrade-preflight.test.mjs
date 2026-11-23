import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  inspectLegacyJsonlStore,
  LegacyJsonlPreflightError,
} from '../scripts/lib/v011-jsonl-upgrade-preflight.mjs';

const version = { declaredVersion: '0.11.0' };
const code = wanted => error =>
  error instanceof LegacyJsonlPreflightError && error.code === wanted;
const row = value => JSON.stringify(value) + '\n';

async function inHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ei-old-preflight-'));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test('no trigger state can be interpreted as a verified active watch owner', async () => {
  await inHome(async home => {
    const file = path.join(home, 'triggers.jsonl');
    await writeFile(file, row({ triggerId: 't', version: '1' }));
    const before = await readFile(file);
    const result = await inspectLegacyJsonlStore(home, version);
    assert.equal(result.status, 'blocked');
    assert.equal(result.scopes[0].counts.activeOrPausedWatches, 1);
    assert.equal(result.scopes[0].counts.missingWatchOwner, 1);
    assert.ok(result.scopes[0].reasons.includes('MISSING_WATCH_OWNER'));
    assert.ok(result.scopes[0].reasons.includes('SOURCE_REPLAY_BOUNDARY_UNKNOWN'));
    assert.equal(result.provenanceVerifiedByFiles, false);
    assert.deepEqual(await readFile(file), before);
  });
});

test('claimed and pending receipts are explicit blockers, not silently treated as delivered', async () => {
  await inHome(async home => {
    const file = path.join(home, 'wake-deliveries.jsonl');
    await writeFile(file, [
      row({ wakeId: 'w1', status: 'pending' }),
      row({ wakeId: 'w1', status: 'claimed' }),
      row({ wakeId: 'w2', status: 'delivered', runtimeReceiptId: 'prior-host-effect' }),
    ].join(''));
    const result = await inspectLegacyJsonlStore(home, version);
    assert.equal(result.scopes[0].counts.latestDeliveries, 2);
    assert.equal(result.scopes[0].counts.deliveredReceipts, 1);
    assert.equal(result.scopes[0].counts.inFlightDeliveries, 1);
    assert.ok(result.scopes[0].reasons.includes('INFLIGHT_WAKE_RECONCILIATION_REQUIRED'));
    assert.ok(result.scopes[0].reasons.includes('HOST_RECEIPT_RECONCILIATION_REQUIRED'));
  });
});

test('source checkpoints and potential negative deadlines are explicitly unsafe', async () => {
  await inHome(async home => {
    await writeFile(path.join(home, 'mcp-client-states.jsonl'),
      row({ connectionId: 'c', eventName: 'x', cursor: 'opaque' }));
    await writeFile(path.join(home, 'temporal-deadlines.jsonl'),
      row({ deadlineId: 'd', status: 'pending' }));
    const result = await inspectLegacyJsonlStore(home, version);
    assert.ok(result.scopes[0].reasons.includes('SOURCE_CURSOR_REPLAY_PROOF_REQUIRED'));
    assert.ok(result.scopes[0].reasons.includes('PATTERN_HISTORY_NOT_TRANSFERABLE'));
    assert.equal(result.scopes[0].counts.mcpCursorUpdates, 1);
    assert.equal(result.scopes[0].counts.oldPatternHistoryRows, 1);
  });
});

test('per-scope folder is independently inspected with no cross-scope row reuse', async () => {
  await inHome(async home => {
    const scope = 'tenant:synthetic-two';
    const sub = path.join(home, 'scopes', Buffer.from(scope).toString('base64url'));
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(home, 'triggers.jsonl'),
      row({ triggerId: 'first', version: '1' }));
    await writeFile(path.join(sub, 'wake-deliveries.jsonl'),
      row({ wakeId: 'scope-two-only', status: 'delivered', runtimeReceiptId: 'r' }));
    const result = await inspectLegacyJsonlStore(home, version);
    assert.equal(result.scopeCount, 2);
    const by = new Map(result.scopes.map(x => [x.scope, x]));
    assert.equal(by.get('default').counts.totalWatches, 1);
    assert.equal(by.get('default').counts.deliveredReceipts, 0);
    assert.equal(by.get(scope).counts.totalWatches, 0);
    assert.equal(by.get(scope).counts.deliveredReceipts, 1);
  });
});

test('rejects invalid JSON, version claims, unknown marker, unknown files and symlinks', async () => {
  await inHome(async home => {
    await assert.rejects(
      inspectLegacyJsonlStore(home, { declaredVersion: '1.0.0' }),
      code('UNSUPPORTED_SOURCE_VERSION'));
    const trigger = path.join(home, 'triggers.jsonl');
    await writeFile(trigger, '{bad-json\n');
    await assert.rejects(inspectLegacyJsonlStore(home, version),
      code('INVALID_JSONL_RECORD'));
    await rm(trigger);
    await writeFile(path.join(home, 'pattern-v2-signature-contract.json'), '{}\n');
    await assert.rejects(inspectLegacyJsonlStore(home, version),
      code('UNRECOGNIZED_OR_NONREGULAR_STORE_ENTRY'));
    await rm(path.join(home, 'pattern-v2-signature-contract.json'));
    const outside = path.join(home, 'external.txt');
    await writeFile(outside, 'synthetic secret');
    await symlink(outside, trigger);
    await assert.rejects(inspectLegacyJsonlStore(home, version),
      code('UNRECOGNIZED_OR_NONREGULAR_STORE_ENTRY'));
  });
});
