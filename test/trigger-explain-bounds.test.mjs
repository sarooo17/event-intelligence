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
  assert.deepEqual(view.evidenceSummary.observedClauseIds, ['merged']);
  assert.deepEqual(view.evidenceSummary.unobservedClauseIds, ['deployed']);
  assert.equal(view.evidenceSummary.selectionBasis, 'latest_match');
  assert.equal(JSON.stringify(view).includes('payload-not-for-inspector'), false);
});

test('history remains complete by default; invalid opt-in limit fails closed', async () => {
  const view = await new TriggerInspector({
    store: testStore(),
  }).inspect({ triggerId: 'release' });
  assert.equal(view.lineage.matchHistory.length, 160);
  assert.equal(view.lineage.historyTruncated, false);
  assert.equal(view.lineage.historyLimit, null);
  for (const limit of [0, -1, 1.5, 501, Infinity, 'all']) {
    assert.throws(() => new TriggerInspector({
      store: testStore(), matchHistoryLimit: limit,
    }), /matchHistoryLimit/);
  }
});

test('explanation reports explicit match selection and no-match basis truthfully', async () => {
  const explicit = await new TriggerInspector({
    store: testStore(),
    matchHistoryLimit: 5,
  }).inspect({ triggerId: 'release', matchId: 'match-1' });
  assert.equal(explicit.evidenceSummary.selectionBasis, 'explicit_match');
  const noMatchStore = testStore();
  noMatchStore.listTriggerMatches = () => [];
  const empty = await new TriggerInspector({
    store: noMatchStore,
  }).inspect({ triggerId: 'release' });
  assert.equal(empty.evidenceSummary.selectionBasis, 'no_match');
  assert.deepEqual(empty.evidenceSummary.unobservedClauseIds, [
    'merged',
    'deployed',
  ]);
});

test('opt-in bounded inspection delegates to store window without full history scan', async () => {
  const store = testStore();
  let windowCalls = 0;
  store.listTriggerMatchHistory = () => {
    throw new Error('unbounded history scan must not run');
  };
  store.getRecentTriggerMatchHistory = async (matchId, { limit }) => {
    windowCalls++;
    assert.equal(matchId, 'match-1');
    assert.equal(limit, 2);
    return {
      records: [
        { status: 'partial', updatedAt: '2026-10-01T12:00:00.000Z', sourceEvents: [] },
        { status: 'matched', updatedAt: '2026-10-01T12:01:00.000Z', sourceEvents: [] },
      ],
      hasMore: true,
      limit,
    };
  };
  const view = await new TriggerInspector({
    store,
    matchHistoryLimit: 2,
  }).inspect({ triggerId: 'release' });
  assert.equal(windowCalls, 1);
  assert.equal(view.lineage.matchHistory.length, 2);
  assert.equal(view.lineage.historyTruncated, true);
  assert.equal(view.lineage.historyLimit, 2);
});

test('malformed optional window contract fails explicitly', async () => {
  const store = testStore();
  store.getRecentTriggerMatchHistory = async () => ({
    records: [],
    hasMore: 'false',
  });
  await assert.rejects(
    () => new TriggerInspector({ store, matchHistoryLimit: 1 })
      .inspect({ triggerId: 'release' }),
    (error) => error.code === 'EVENT_INTELLIGENCE_HISTORY_WINDOW_INVALID',
  );
});

test('oversized store-provided windows cannot bypass requested history limit', async () => {
  const store = testStore();
  store.getRecentTriggerMatchHistory = async () => ({
    records: Array.from({ length: 3 }, () => ({
      status: 'partial',
      updatedAt: '2026-10-01T12:00:00.000Z',
      sourceEvents: [],
    })),
    hasMore: true,
    limit: 2,
  });
  await assert.rejects(
    () => new TriggerInspector({
      store,
      matchHistoryLimit: 2,
    }).inspect({ triggerId: 'release' }),
    (error) => error.code === 'EVENT_INTELLIGENCE_HISTORY_WINDOW_INVALID',
  );
});

test('invalid bounded-window records fail with the stable contract error', async () => {
  const malformed = [
    null,
    { status: 'partial', updatedAt: '2026-10-01T12:00:00.000Z' },
    { status: 'partial', updatedAt: 'invalid', sourceEvents: [] },
    { updatedAt: '2026-10-01T12:00:00.000Z', sourceEvents: [] },
    {
      status: 'partial',
      updatedAt: '2026-10-01T12:00:00.000Z',
      sourceEvents: [{ wrongField: 'event-1' }],
    },
  ];
  for (const record of malformed) {
    const store = testStore();
    store.getRecentTriggerMatchHistory = async () => ({
      records: [record],
      hasMore: false,
      limit: 1,
    });
    await assert.rejects(
      () => new TriggerInspector({
        store,
        matchHistoryLimit: 1,
      }).inspect({ triggerId: 'release' }),
      (error) => error.code === 'EVENT_INTELLIGENCE_HISTORY_WINDOW_INVALID',
    );
  }
});
