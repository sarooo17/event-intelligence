import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';

const NOW = '2026-10-18T12:00:00.000Z';

function definition(triggerId, slot, lifecycle = {}, event = 'issue.updated') {
  return {
    triggerId, version: '1',
    clauses: [{
      id: 'changed', event, serverId: 'mcp-fixture',
      arguments: { repository: 'acme/erp' },
      where: [{ path: 'slot', op: 'eq', value: slot }],
    }],
    pattern: { version: '2', root: { kind: 'event', ref: 'changed' } },
    withinMs: 60000, lifecycle,
    target: { runtime: 'fixture-runtime', kind: 'task', id: triggerId },
  };
}
function occurrence(id, slot, args = { repository: 'acme/erp' }) {
  return {
    traceId: 'trace-' + id, sourceEventId: id,
    name: 'issue.updated', serverId: 'mcp-fixture',
    occurredAt: NOW, subscriptionArguments: args,
    data: { slot },
  };
}

test('unrelated non-mutating definitions never make a lifecycle state roundtrip', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-lifecycle-prefilter-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    for (let i = 0; i < 48; i++) {
      await store.putTrigger(definition('ordinary-' + i, i));
    }
    await store.setTriggerState('ordinary-25', '1', 'paused');

    const reads = [];
    const original = store.getTriggerState.bind(store);
    store.getTriggerState = async (...args) => {
      reads.push(args.join('@'));
      return original(...args);
    };

    const engine = new CompositeTriggerEngine(
      store, null, () => new Date(NOW),
    );

    const match = await engine.ingest(occurrence('first', 24));
    assert.equal(match.length, 1);
    assert.equal(match[0].triggerId, 'ordinary-24');
    assert.equal(match[0].match.status, 'matched');
    assert.ok(reads.length >= 1 && reads.length < 10,
      'the matching trigger may be re-read during Pattern bookkeeping');
    assert.ok(reads.every(key => key === 'ordinary-24@1'),
      'no unrelated eligible trigger may trigger a lifecycle read');

    reads.length = 0;
    const paused = await engine.ingest(occurrence('second', 25));
    assert.deepEqual(paused, [], 'paused matching trigger must remain blocked');
    assert.deepEqual(reads, ['ordinary-25@1']);

    reads.length = 0;
    const wrongSource = await engine.ingest(occurrence('third', 24, {
      repository: 'another/erp',
    }));
    assert.deepEqual(wrongSource, []);
    assert.deepEqual(reads, []);
    assert.equal(await store.verifyAudit(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nonmatching expiry, lease expiry and completed counts preserve durable lifecycle/audit effects', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-lifecycle-effects-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    await store.putTrigger(definition(
      'past-expiry', -100, { expiresAt: '2026-10-17T11:00:00.000Z' },
      'unrelated.event',
    ));
    await store.putTrigger(definition(
      'past-lease', -101, { leaseUntil: '2026-10-17T11:00:00.000Z' },
      'unrelated.event',
    ));
    await store.putTrigger(definition(
      'one-shot-saturated', -102, { oneShot: true },
      'unrelated.event',
    ));
    await store.putTrigger(definition(
      'max-firings-saturated', -103, { maxFirings: 1 },
      'unrelated.event',
    ));
    await store.putTrigger(definition('nonmatching-cooldown', -104, {
      cooldownMs: 60000,
    }, 'unrelated.event'));
    await store.setTriggerState('one-shot-saturated', '1', 'active', null, {
      fireCount: 1,
    });
    await store.setTriggerState('max-firings-saturated', '1', 'active', null, {
      fireCount: 1,
    });

    const reads = [];
    const original = store.getTriggerState.bind(store);
    store.getTriggerState = async (...args) => {
      reads.push(args.join('@'));
      return original(...args);
    };
    const engine = new CompositeTriggerEngine(store, null, () => new Date(NOW));
    assert.deepEqual(await engine.ingest(occurrence('unrelated', 222)), []);

    assert.deepEqual(new Set(reads), new Set([
      'past-expiry@1', 'past-lease@1',
      'one-shot-saturated@1', 'max-firings-saturated@1',
    ]), 'state checks for nonmatching mutation-capable lifecycle must remain');

    for (const id of ['past-expiry', 'past-lease']) {
      assert.equal(original(id, '1').status, 'expired');
      assert.ok(store.listAudit().some(record =>
        record.kind === 'trigger.lifecycle_expired' &&
        record.entityId === id,
      ), 'lifecycle expiry audit must be persisted for ' + id);
    }
    for (const id of ['one-shot-saturated', 'max-firings-saturated']) {
      assert.equal(original(id, '1').status, 'completed');
      assert.equal(original(id, '1').fireCount, 1);
    }
    assert.equal(original('nonmatching-cooldown', '1').status, 'active');
    assert.equal(await store.verifyAudit(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('paused regex predicates are never evaluated before lifecycle authorization', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-paused-regex-prefilter-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const pattern = '(a+)+' + String.fromCharCode(36);
    const def = definition('paused-regex', 42);
    def.clauses[0].where = [{ path: 'message', op: 'regex', value: pattern }];
    await store.putTrigger(def);
    await store.setTriggerState('paused-regex', '1', 'paused');
    const engine = new CompositeTriggerEngine(store, null, () => new Date(NOW));

    let regexEvaluations = 0;
    const originalTest = RegExp.prototype.test;
    RegExp.prototype.test = function (value) {
      if (this.source === pattern) {
        regexEvaluations++;
        throw new Error('paused regex evaluated before lifecycle check');
      }
      return originalTest.call(this, value);
    };
    let suppressed;
    try {
      suppressed = await engine.ingest({
        ...occurrence('paused-regex-event', 42),
        data: { slot: 42, message: 'aaaa' },
      });
    } finally {
      RegExp.prototype.test = originalTest;
    }
    assert.deepEqual(suppressed, []);
    assert.equal(regexEvaluations, 0);

    await store.setTriggerState('paused-regex', '1', 'active');
    const allowed = await engine.ingest({
      ...occurrence('active-regex-event', 42),
      data: { slot: 42, message: 'aaaa' },
    });
    assert.equal(allowed.length, 1);
    assert.equal(allowed[0].match.status, 'matched');
    assert.equal(await store.verifyAudit(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
