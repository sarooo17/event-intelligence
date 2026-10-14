import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema,
  evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

function definition(maxSemanticEvaluations) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: {
      kind: 'semantic',
      id: 'cached-importance',
      refs: ['issue'],
      instruction: 'Is this update important?',
      input: ['issue.title'],
      matchThreshold: 0.8,
      rejectThreshold: 0.2,
      uncertain: 'reject',
      execution: { cache: true, timeoutMs: 1000, onUnavailable: 'error' },
      child: { kind: 'event', ref: 'issue' },
    },
    partitionBy: [],
    selection: { overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100 },
    execution: {
      maxCandidates: 32,
      maxSemanticEvaluations,
      maxBufferedEvents: 32,
    },
  });
}

function event(index) {
  return {
    clauseId: 'issue',
    traceId: 'budget-cache-' + index,
    sourceEventId: 'issue-' + index,
    eventName: 'github.issue.updated',
    serverId: 'fixture-github',
    provider: 'conformance',
    occurredAt: new Date(Date.UTC(2026, 9, 14, 10, index)).toISOString(),
    subscriptionArguments: {},
    data: { title: 'Synthetic issue ' + index },
  };
}

function fixture() {
  const decisions = new Map();
  let calls = 0;
  let writes = 0;
  const evaluator = {
    cacheIdentity: 'conformance/fixed-model:v1',
    async evaluate() {
      calls++;
      return { evaluator: 'conformance/fixed-model:v1', probability: 0.95 };
    },
  };
  return {
    evaluator,
    cache: {
      get: key => decisions.get(key) ?? null,
      set: (key, decision) => { writes++; decisions.set(key, decision); },
    },
    get calls() { return calls; },
    get writes() { return writes; },
    get size() { return decisions.size; },
  };
}

async function evaluate(fixture, inputs, maxSemanticEvaluations, namespace = 'tenant-1:trigger@1') {
  return evaluatePatternV2({
    definition: definition(maxSemanticEvaluations),
    events: inputs,
    evaluator: fixture.evaluator,
    semanticCache: fixture.cache,
    semanticCacheNamespace: namespace,
    now: new Date('2026-10-14T12:00:00.000Z'),
  });
}

test('zero new-call budget permits an exact durable cached semantic decision', async () => {
  const state = fixture();
  const source = [event(0)];
  const seeded = await evaluate(state, source, 1);
  assert.equal(seeded.matches.length, 1);
  assert.equal(seeded.truncated, false);
  assert.equal(state.calls, 1);
  assert.equal(state.size, 1);

  const cached = await evaluate(state, source, 0);
  assert.deepEqual(
    cached.matches.map(x => x.events.map(e => e.sourceEventId)),
    [['issue-0']],
  );
  assert.equal(cached.truncated, false,
    'zero-call budget must not falsely truncate a fully cached run');
  assert.equal(cached.semanticEvaluations, 0);
  assert.equal(cached.semanticCacheHits, 1);
  assert.equal(cached.semanticCacheMisses, 0);
  assert.equal(state.calls, 1, 'cached evaluation cannot invoke a provider');
  assert.equal(state.writes, 1, 'cache hit cannot create a redundant decision');
});

test('cache miss at zero call budget still signals truncation, never no-match', async () => {
  const state = fixture();
  const result = await evaluate(state, [event(0)], 0);
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.pending, []);
  assert.equal(result.truncated, true);
  assert.equal(result.semanticEvaluations, 0);
  assert.equal(state.calls, 0);
  assert.equal(state.size, 0);
});

test('cached prefix plus uncached suffix yields partial result with truncation', async () => {
  const state = fixture();
  await evaluate(state, [event(0)], 1);
  const result = await evaluate(state, [event(1), event(0)], 0);
  assert.deepEqual(
    result.matches.map(x => x.events[0].sourceEventId),
    ['issue-0'],
  );
  assert.equal(result.truncated, true,
    'uncached second candidate must remain explicitly incomplete');
  assert.equal(result.semanticEvaluations, 0);
  assert.equal(result.semanticCacheHits, 1);
  assert.equal(state.calls, 1);
});

test('an earlier cache miss cannot hide a later valid cached decision', async () => {
  const state = fixture();
  await evaluate(state, [event(1)], 1);
  // Chronological sorting means the uncached issue-0 is visited first.
  const result = await evaluate(state, [event(1), event(0)], 0);
  assert.deepEqual(
    result.matches.map(x => x.events[0].sourceEventId),
    ['issue-1'],
    'scan must continue after the earlier over-budget miss',
  );
  assert.equal(result.truncated, true,
    'earlier unresolved candidate still makes the entire result incomplete');
  assert.equal(result.semanticEvaluations, 0);
  assert.equal(result.semanticCacheHits, 1);
  assert.equal(state.calls, 1);
  assert.equal(state.writes, 1);
});

test('cache namespace boundaries remain effective despite a zero call budget', async () => {
  const state = fixture();
  await evaluate(state, [event(0)], 1, 'tenant-a:trigger@1');
  const foreign = await evaluate(state, [event(0)], 0, 'tenant-b:trigger@1');
  assert.equal(foreign.truncated, true);
  assert.deepEqual(foreign.matches, []);
  assert.equal(foreign.semanticCacheHits, 0);
  assert.equal(state.calls, 1,
    'cache from another namespace cannot bypass the call budget');
});
