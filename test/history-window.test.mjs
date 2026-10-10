import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';

function matchedRecord(index) {
  return {
    protocolVersion: '0.2.0',
    schemaVersion: 'trigger.v0.2',
    matchId: 'history-match',
    triggerId: 'history-trigger',
    triggerVersion: '1',
    status: 'matched',
    partitionKey: null,
    openedAt: '2026-10-05T10:00:00.000Z',
    expiresAt: '2026-10-05T10:05:00.000Z',
    updatedAt: new Date(Date.UTC(2026, 9, 5, 10, 0, index)).toISOString(),
    sourceEvents: [],
    semanticDecision: null,
    patternState: {
      version: '2',
      role: 'match',
      signature: 'history-match',
      semanticDecisions: [],
    },
    firedWakeId: null,
    derivedEventIds: [],
  };
}

test('reference store offers the same bounded ordered window after restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-history-window-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    for (let i = 0; i < 5; i += 1) {
      await store.appendTriggerMatch(matchedRecord(i));
    }
    const current = store.getRecentTriggerMatchHistory('history-match', { limit: 2 });
    assert.equal(current.records.length, 2);
    assert.equal(current.hasMore, true);
    assert.equal(current.records[0].updatedAt, '2026-10-05T10:00:03.000Z');
    assert.equal(current.records[1].updatedAt, '2026-10-05T10:00:04.000Z');
    assert.deepEqual(
      store.getRecentTriggerMatchHistory('other-match').records,
      [],
    );
    assert.throws(
      () => store.getRecentTriggerMatchHistory('history-match', { limit: 999 }),
      (error) => error.code === 'EVENT_INTELLIGENCE_HISTORY_LIMIT_INVALID',
    );
    await store.close();

    const restored = new PersistentEventStore(dir);
    await restored.init();
    const recent = restored.getRecentTriggerMatchHistory('history-match', { limit: 5 });
    assert.equal(recent.records.length, 5);
    assert.equal(recent.hasMore, false);
    await restored.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
