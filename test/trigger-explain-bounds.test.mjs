import assert from 'node:assert/strict';
import test from 'node:test';
import { TriggerInspector } from '../scripts/lib/trigger-inspector.mjs';

function testStore() {
  const event = {
    clauseId: 'merged', serverId: 'github', eventName: 'pr.merged',
    sourceEventId: 'pr-1', traceId: 'trace-1',
    occurredAt: '2026-10-01T12:00:00.000Z',
    data: { message: 'payload-not-for-inspector' },
  };
  const match = {
    matchId: 'match-1', triggerId: 'release', triggerVersion: '1',
    status: 'partial', sourceEvents: [event], partitionKey: null,
    openedAt: event.occurredAt,
    expiresAt: '2026-10-01T13:00:00.000Z',
    updatedAt: '2026-10-01T12:10:00.000Z',
    patternState: null, firedWakeId: null,
  };
  return {
    listTriggers: () => [{
      triggerId: 'release', version: '1',
      clauses: [
        { id: 'merged', event: 'pr.merged' },
        { id: 'deployed', event: 'deployment.succeeded' },
      ],
      pattern: { root: { kind: 'allOf', children: [
        { kind: 'event', ref: 'merged' },
        { kind: 'event', ref: 'deployed' },
      ] } },
    }],
    getTriggerState: () => ({ status: 'active', fireCount: 0 }),
    listTriggerMatches: () => [match],
    listTriggerMatchHistory: () => Array.from({ length: 160 }, (_, i) => ({
      ...match,
      updatedAt: new Date(Date.UTC(2026, 9, 1, 12, 0, i)).toISOString(),
    })),
  };
}

test('inspector bounds history and gives evidence-backed progress', async () => {
  const view = await new TriggerInspector({
    store: testStore(), matchHistoryLimit: 12,
  }).inspect({ triggerId: 'release' });
  assert.equal(view.lineage.matchHistory.length, 12);
  assert.equal(view.lineage.historyTruncated, true);
  assert.equal(view.lineage.historyLimit, 12);
  assert.deepEqual(view.progress.observedClauseIds, ['merged']);
  assert.deepEqual(view.progress.waitingClauseIds, ['deployed']);
  assert.equal(view.progress.evidenceBasis, 'latest_match_only');
  assert.equal(JSON.stringify(view).includes('payload-not-for-inspector'), false);
});

test('default budget is 100 and invalid budget fails closed', async () => {
  const view = await new TriggerInspector({
    store: testStore(),
  }).inspect({ triggerId: 'release' });
  assert.equal(view.lineage.matchHistory.length, 100);
  assert.equal(view.lineage.historyTruncated, true);
  for (const limit of [0, -1, 1.5, 501, Infinity, 'all']) {
    assert.throws(() => new TriggerInspector({
      store: testStore(), matchHistoryLimit: limit,
    }), /matchHistoryLimit/);
  }
});
