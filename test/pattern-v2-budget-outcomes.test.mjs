import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema,
  evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

const make = (ref, index) => ({
  clauseId: ref,
  sourceEventId: 'budget:' + index,
  traceId: 'trace:budget:' + index,
  eventName: ref + '.event',
  occurredAt: new Date(Date.UTC(2026, 9, 14, 10, 0, index)).toISOString(),
  provider: 'bounded-reference',
  serverId: 'budget-oracle',
  subscriptionArguments: {},
  data: { note: 'synthetic-' + ref },
});

// The sole z->b adjacent pair is after TWO earlier a occurrences.
// A candidate cap of two drops z in anyOf(a,z), so sequence(next)
// reports zero matches despite the full independent finite-stream witness.
const fixture = ['a', 'a', 'z', 'b'].map(make);
const origin = ['a', 'a', 'z', 'b'];
const base = {
  version: '2',
  root: {
    kind: 'sequence',
    contiguity: 'next',
    children: [
      { kind: 'anyOf', children: [
        { kind: 'event', ref: 'a' },
        { kind: 'event', ref: 'z' },
      ] },
      { kind: 'event', ref: 'b' },
    ],
  },
  partitionBy: [],
  selection: {
    overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100,
  },
};

function definition(cap) {
  return PatternAstV2DefinitionSchema.parse({
    ...base,
    execution: {
      maxCandidates: cap,
      maxSemanticEvaluations: 0,
      maxBufferedEvents: 16,
    },
  });
}

// Reference model is event-index-only, not the Pattern evaluator or its
// candidate filtering. Require distinct IDs and timestamps for this subset.
function referenceAdjacentPair(events) {
  const ordered = [...events].sort((a, b) =>
    Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const ids = new Set(ordered.map(x => x.sourceEventId));
  assert.equal(ids.size, ordered.length);
  const pairs = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    if (['a', 'z'].includes(ordered[i].clauseId) &&
        ordered[i + 1].clauseId === 'b') {
      pairs.push([
        ordered[i].sourceEventId,
        ordered[i + 1].sourceEventId,
      ]);
    }
  }
  return pairs;
}

function ids(evaluation) {
  return evaluation.matches.map(match =>
    match.events.map(event => event.sourceEventId));
}

function shuffled(events, seed) {
  let state = seed >>> 0;
  const result = [...events];
  for (let index = result.length - 1; index > 0; index--) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const offset = state % (index + 1);
    [result[index], result[offset]] = [result[offset], result[index]];
  }
  return result;
}

test('bounded candidate budget cannot quietly transform a real match into a conclusive no-match', async () => {
  assert.deepEqual(origin, fixture.map(e => e.clauseId));
  assert.deepEqual(referenceAdjacentPair(fixture), [['budget:2', 'budget:3']]);
  for (let seed = 1; seed <= 100; seed++) {
    const arrival = shuffled(fixture, seed);
    const complete = await evaluatePatternV2({
      definition: definition(8), events: arrival,
    });
    assert.equal(complete.truncated, false, 'seed=' + seed);
    assert.deepEqual(ids(complete), referenceAdjacentPair(arrival),
      'independent complete model seed=' + seed);

    const exhausted = await evaluatePatternV2({
      definition: definition(2), events: arrival,
    });
    assert.equal(exhausted.matches.length, 0, 'seed=' + seed);
    assert.equal(exhausted.pending.length, 0, 'seed=' + seed);
    assert.equal(exhausted.truncated, true,
      'a budgeted zero-match result is inconclusive, seed=' + seed);

    const legitimateNoMatch = await evaluatePatternV2({
      definition: definition(8), events: arrival.filter(x => x.clauseId !== 'b'),
    });
    assert.equal(legitimateNoMatch.matches.length, 0);
    assert.equal(legitimateNoMatch.truncated, false,
      'complete absence remains distinct from resource exhaustion');
  }
});

const semantic = (maxSemanticEvaluations) =>
  PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: {
      kind: 'semantic',
      id: 'budget-check',
      refs: ['a'],
      instruction: 'Is this eligible?',
      input: ['a.note'],
      matchThreshold: 0.8,
      rejectThreshold: 0.2,
      uncertain: 'escalate',
      execution: { cache: false, timeoutMs: 1000, onUnavailable: 'error' },
      child: { kind: 'event', ref: 'a' },
    },
    partitionBy: [],
    selection: { overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100 },
    execution: {
      maxCandidates: 16,
      maxSemanticEvaluations,
      maxBufferedEvents: 16,
    },
  });

test('semantic evaluation exhaustion is inconclusive without executing a host evaluator', async () => {
  let calls = 0;
  const evaluator = {
    async evaluate() {
      calls++;
      return { evaluator: 'synthetic/budget', probability: 0.95, metadata: {} };
    },
  };
  const event = fixture[0];
  const exhausted = await evaluatePatternV2({
    definition: semantic(0), events: [event], evaluator,
  });
  assert.equal(exhausted.truncated, true);
  assert.deepEqual(exhausted.matches, []);
  assert.equal(exhausted.semanticEvaluations, 0);
  assert.equal(calls, 0);

  const complete = await evaluatePatternV2({
    definition: semantic(1), events: [event], evaluator,
  });
  assert.equal(complete.truncated, false);
  assert.equal(complete.matches.length, 1);
  assert.equal(complete.semanticEvaluations, 1);
  assert.equal(calls, 1);

  const actuallyAbsent = await evaluatePatternV2({
    definition: semantic(0), events: [], evaluator,
  });
  assert.equal(actuallyAbsent.truncated, false);
  assert.equal(actuallyAbsent.matches.length, 0);
  assert.equal(calls, 1);
});

test('malformed AST budgets fail schema parsing, not a nominal no-match', () => {
  for (const execution of [
    { maxCandidates: 0, maxSemanticEvaluations: 1, maxBufferedEvents: 16 },
    { maxCandidates: 10001, maxSemanticEvaluations: 1, maxBufferedEvents: 16 },
    { maxCandidates: 2, maxSemanticEvaluations: -1, maxBufferedEvents: 16 },
    { maxCandidates: 2, maxSemanticEvaluations: 1001, maxBufferedEvents: 16 },
    { maxCandidates: 2, maxSemanticEvaluations: 0, maxBufferedEvents: 0 },
  ]) {
    assert.equal(PatternAstV2DefinitionSchema.safeParse({
      ...base, execution,
    }).success, false, JSON.stringify(execution));
  }
});
