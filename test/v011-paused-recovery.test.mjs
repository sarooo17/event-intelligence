import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { inspectLegacyJsonlStore } from '../scripts/lib/v011-jsonl-upgrade-preflight.mjs';
import { stageLegacyWatchesPaused } from '../scripts/lib/v011-jsonl-paused-recovery.mjs';

const row = value => JSON.stringify(value) + '\n';
const version = '0.11.0';
const watcher = (id, event = 'fixture.changed') => ({
  triggerId: id,
  version: '1',
  conditionOnly: true,
  clauses: [{ id: 'a', event, serverId: 'fixture', where: [], arguments: {} }],
  pattern: { version: '2', root: { kind: 'event', ref: 'a' } },
  withinMs: 60000,
});
const owner = {
  type: 'owner', principal_id: 'reapproved-owner', tenant_id: 'synthetic',
};
const actor = {
  type: 'agent', principal_id: 'host-recovery', tenant_id: 'synthetic',
};
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ei-v011-stage-'));
  const old = path.join(root, 'source');
  const target = path.join(root, 'candidate');
  await mkdir(old);
  await writeFile(path.join(old, 'triggers.jsonl'), row(watcher('test-watch')));
  await writeFile(path.join(old, 'trigger-states.jsonl'),
    row({
      triggerId: 'test-watch', version: '1', status: 'active',
      owner: { type: 'owner', principal_id: 'legacy-owner' },
    }));
  try {
    await run({
      root, old, target,
      preflight: () => inspectLegacyJsonlStore(old, { declaredVersion: version }),
      stage: async ({ digest, authorize = async () => ({ owner, actor }) } = {}) => {
        const result = await inspectLegacyJsonlStore(old, { declaredVersion: version });
        return stageLegacyWatchesPaused({
          sourceDir: old,
          targetDir: target,
          expectedSourceSnapshotSha256: digest ?? result.sourceSnapshotSha256,
          declaredVersion: version,
          authorizeWatch: authorize,
        });
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('new v1 quarantine contains reauthorized watch paused and no old receipt', async () => {
  await fixture(async ({ old, target, stage }) => {
    const oldBytes = await readFile(path.join(old, 'triggers.jsonl'));
    const report = await stage();
    assert.equal(report.stagedWatches, 1);
    assert.equal(report.allWatchesPaused, true);
    assert.equal(report.safeToResumeOrDeploy, false);
    const store = new PersistentEventStore(target);
    await store.init();
    assert.equal(store.listTriggers().length, 1);
    assert.equal(store.getTriggerState('test-watch', '1').status, 'paused');
    assert.equal(store.getTriggerState('test-watch', '1').owner.principal_id,
      'reapproved-owner');
    assert.deepEqual(store.getTriggerState('test-watch', '1').connectionIds, []);
    assert.equal(store.getWakeDelivery('nonexistent-old-wake'), null);
    await store.close();
    assert.deepEqual(await readFile(path.join(old, 'triggers.jsonl')), oldBytes);
  });
});

test('host denial or a changed snapshot prevents creation of candidate', async () => {
  await fixture(async ({ old, target, stage, preflight }) => {
    await assert.rejects(stage({ authorize: async () => null }),
      error => error?.code === 'HOST_REAUTHORIZATION_DENIED');
    await assert.rejects(readFile(path.join(target, 'triggers.jsonl')),
      { code: 'ENOENT' });
    const expected = (await preflight()).sourceSnapshotSha256;
    await appendFile(path.join(old, 'event-sources.jsonl'),
      row({ sourceId: 'new-source', connectionId: 'untrusted', eventName: 'event' }));
    await assert.rejects(stage({ digest: expected }),
      error => error?.code === 'SOURCE_SNAPSHOT_CHANGED');
  });
});

test('in-flight legacy wake refuses staging, even when host approves owner', async () => {
  await fixture(async ({ old, target, stage }) => {
    await writeFile(path.join(old, 'wake-deliveries.jsonl'),
      row({ wakeId: 'pending-old-wake', status: 'claimed', leaseOwner: 'old-worker' }));
    await assert.rejects(stage(),
      error => error?.code === 'UNSAFE_LEGACY_WATCH_OR_RECEIPT_STATE');
    await assert.rejects(readFile(path.join(target, 'legacy-recovery-quarantine.json')),
      { code: 'ENOENT' });
  });
});

test('existing target is never modified', async () => {
  await fixture(async ({ root, target, stage }) => {
    await mkdir(target);
    const sentinel = path.join(target, 'keep.txt');
    await writeFile(sentinel, 'do not touch');
    await assert.rejects(stage(), { code: 'EEXIST' });
    assert.equal(await readFile(sentinel, 'utf8'), 'do not touch');
  });
});

test('interruption between paused-state append and trigger append cannot expose an active watch', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-v1-paused-boundary-'));
  try {
    const one = new PersistentEventStore(dir);
    await one.init();
    await one.setTriggerState('interrupted-watch', '1', 'paused', actor, {
      owner, connectionIds: [],
    });
    await one.close();

    // SIGKILL in the gap after durable PAUSED, before trigger definition:
    // a cold startup must see no executable watch.
    const two = new PersistentEventStore(dir);
    await two.init();
    assert.equal(two.listTriggers().length, 0);
    assert.equal(two.getTriggerState('interrupted-watch', '1').status, 'paused');

    // Simulate a second interruption immediately after the definition
    // becomes durable, then independently cold start again.
    await two.putTrigger(watcher('interrupted-watch'));
    await two.close();
    const three = new PersistentEventStore(dir);
    await three.init();
    assert.equal(three.listTriggers().length, 1);
    assert.equal(three.getTriggerState('interrupted-watch', '1').status, 'paused');
    assert.deepEqual(three.getTriggerState('interrupted-watch', '1').connectionIds, []);
    await three.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
