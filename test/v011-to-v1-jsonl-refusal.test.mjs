import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { PersistentEventStore as CurrentStore } from '../scripts/lib/persistent-event-store.mjs';

// A REAL published 0.11.0 package is installed into an isolated runner
// directory by the [legacy-upgrade] CI job. This test never operates on an
// owner's Home. No source mutator, migration, marker forgery or live rollout.
const legacyRoot = process.env.EI_V011_PACKAGE_ROOT;

async function snapshot(dir) {
  const files = [];
  async function walk(root, relative = '') {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await walk(path.join(root, entry.name), rel);
      } else if (entry.isFile()) {
        const bytes = await readFile(path.join(root, entry.name));
        files.push({
          path: rel.replaceAll(path.sep, '/'),
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      } else {
        throw new Error('Unexpected non-file entry in isolated fixture');
      }
    }
  }
  await walk(dir);
  return files;
}

test('published 0.11.0 populated JSONL watch+receipt cannot be silently opened as 1.0.0', {
  skip: !legacyRoot && 'Requires exact old npm package in isolated legacy-upgrade CI',
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ei-v011-to-v1-proof-'));
  const original = path.join(temporary, 'v011-original');
  const clone = path.join(temporary, 'v1-candidate-clone');
  try {
    const published = JSON.parse(
      await readFile(path.join(legacyRoot, 'package.json'), 'utf8'),
    );
    assert.equal(published.name, 'mcp-event-intelligence');
    assert.equal(published.version, '0.11.0');
    const { PersistentEventStore: LegacyStore } = await import(pathToFileURL(
      path.join(legacyRoot, 'scripts/lib/persistent-event-store.mjs'),
    ).href);

    const old = new LegacyStore(original);
    await old.init();
    const watch = {
      triggerId: 'synthetic-legacy-watch',
      version: '1',
      clauses: [{
        id: 'signal',
        event: 'fixture.changed',
        serverId: 'fixture',
        arguments: {},
        where: [],
      }],
      pattern: { version: '2', root: { kind: 'event', ref: 'signal' } },
      withinMs: 60_000,
      target: { runtime: 'muffin', kind: 'task', id: 'legacy-owner-turn' },
    };
    await old.putTrigger(watch);
    await old.setTriggerState('synthetic-legacy-watch', '1', 'active', {
      type: 'agent', principal_id: 'synthetic-owner',
    }, {
      owner: { type: 'owner', principal_id: 'synthetic-owner', tenant_id: 'fixture' },
      connectionIds: ['fixture-connection'],
    });

    // Use the OLD published store's own durable receipt lifecycle, not a
    // handwritten JSON row or an in-memory observer.
    await old.ensureWakeDelivery({
      wakeId: 'synthetic-old-wake',
      triggerId: 'synthetic-legacy-watch',
      triggerVersion: '1',
      matchId: 'synthetic-old-match',
      runtime: 'muffin',
    });
    const claimed = await old.claimWakeDelivery('synthetic-old-wake', {
      workerId: 'fixture-v011-worker',
    });
    assert.equal(claimed?.status, 'claimed');
    const delivered = await old.completeWakeDelivery('synthetic-old-wake', {
      workerId: 'fixture-v011-worker',
      runtimeReceiptId: 'synthetic-prior-host-receipt',
    });
    assert.equal(delivered?.status, 'delivered');
    await old.close();

    // A real old binary can cold-reopen both the watch and durable receipt.
    const oldReopened = new LegacyStore(original);
    await oldReopened.init();
    assert.equal(oldReopened.listTriggers().length, 1);
    assert.equal(
      oldReopened.getWakeDelivery('synthetic-old-wake')?.runtimeReceiptId,
      'synthetic-prior-host-receipt',
    );
    assert.equal(oldReopened.getWakeDelivery('synthetic-old-wake')?.status, 'delivered');
    await oldReopened.close();

    await cp(original, clone, { recursive: true });
    const before = await snapshot(clone);
    const v1 = new CurrentStore(clone);
    await assert.rejects(v1.init(), error =>
      error?.code === 'EVENT_INTELLIGENCE_PATTERN_V2_SIGNATURE_INCOMPATIBLE',
    );
    assert.deepEqual(await snapshot(clone), before,
      'v1 cold start must not alter a populated v0.11 clone');

    // Reproducible rollback: the original old binary can still read the copy,
    // including the previous receipt. This is NOT a successful migration.
    const rollback = new LegacyStore(clone);
    await rollback.init();
    assert.equal(rollback.listTriggers().length, 1);
    assert.equal(
      rollback.getWakeDelivery('synthetic-old-wake')?.runtimeReceiptId,
      'synthetic-prior-host-receipt',
    );
    await rollback.close();
    assert.deepEqual(await snapshot(clone), before);

    console.log(JSON.stringify({
      schema: 'ei-v011-to-v1-populated-jsonl-refusal.v1',
      publishedLegacyVersion: published.version,
      oldWatchAndDeliveredReceipt: 'verified',
      v1ColdStart: 'refused-as-incompatible',
      oldBinaryRollback: 'verified-with-prior-receipt',
      oldStoreBytesAfterV1Attempt: 'unchanged',
      migrationPerformed: false,
      hostEffectReplayCertified: false,
    }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
