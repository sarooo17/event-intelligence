import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema,
  evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';
import {
  deterministicRandom,
  shuffled,
} from '../scripts/evidence/reference-sequence-oracle.mjs';
import {
  referenceNotNext,
} from '../scripts/evidence/reference-notnext-oracle.mjs';

const start = Date.UTC(2026, 9, 13, 12, 0, 0);
const definition = PatternAstV2DefinitionSchema.parse({
  version: '2',
  root: {
    kind: 'notNext',
    child: { kind: 'event', ref: 'a' },
    forbidden: { kind: 'event', ref: 'b' },
  },
  partitionBy: [],
  selection: {
    overlap: 'allow',
    afterMatch: 'keepAll',
    maxMatchesPerEvent: 100,
  },
  execution: {
    maxCandidates: 512,
    maxSemanticEvaluations: 0,
    maxBufferedEvents: 512,
  },
});

function occurrence(ref, i, seed) {
  return {
    clauseId: ref,
    traceId: 'notnext:' + seed + ':trace:' + i,
    // IDs are deliberately reverse lexical relative to event time:
    // sorting by ID instead of occurredAt must fail on mixed traces.
    sourceEventId: 'notnext:' + seed + ':id:' + String(30 - i).padStart(2, '0'),
    eventName: ref + '.event',
    occurredAt: new Date(start + i * 137).toISOString(),
    provider: 'oracle',
    serverId: 'bounded',
    subscriptionArguments: {},
    data: {},
  };
}

function candidateIds(output) {
  return output.matches
    .map(candidate => {
      assert.equal(candidate.events.length, 1);
      assert.equal(candidate.events[0]?.clauseId, 'a');
      assert.equal(candidate.bindings.a?.[0]?.sourceEventId,
        candidate.events[0]?.sourceEventId);
      return candidate.events[0].sourceEventId;
    })
    .sort();
}

test('notNext matches independent bounded reference across 250 seeds and three arrival permutations', async () => {
  const kinds = ['a', 'b', 'noise'];
  const witnessed = new Set();
  for (let seed = 1; seed <= 250; seed++) {
    const random = deterministicRandom(Math.imul(seed, 48271) ^ 0x78b9a31);
    const length = 1 + ((seed - 1) % 10);
    const source = Array.from({ length }, (_, i) =>
      occurrence(kinds[Math.floor(random() * kinds.length)], i, seed));
    for (let index = 0; index < source.length; index++) {
      if (source[index].clauseId !== 'a') continue;
      witnessed.add(source[index + 1]?.clauseId ?? 'end');
    }
    const expected = referenceNotNext(source);
    for (let round = 0; round < 3; round++) {
      const delivered = shuffled(source, random);
      const actual = await evaluatePatternV2({
        definition,
        events: delivered,
      });
      assert.equal(actual.truncated, false, 'seed=' + seed);
      assert.deepEqual(candidateIds(actual), expected,
        'seed=' + seed + ' round=' + round +
        ' source=' + source.map(item => item.clauseId).join(','));
      assert.equal(actual.pending.length, 0,
        'snapshot notNext currently has no pending negative finality');
    }
  }
  assert.deepEqual([...witnessed].sort(), ['a', 'b', 'end', 'noise']);
});

test('notNext adjacency includes unrelated noise and preserves tail-anchor snapshot semantics', async () => {
  for (const [refs, matchedIndexes] of [
    [['a', 'b'], []],
    [['a', 'noise', 'b'], [0]],
    [['a', 'a', 'b'], [0]],
    [['b', 'a'], [1]],
    [['a', 'b', 'a', 'noise', 'b', 'a'], [2, 5]],
    [['a'], [0]],
  ]) {
    const source = refs.map((ref, i) => occurrence(ref, i, 'boundary'));
    const expected = matchedIndexes.map(i => source[i].sourceEventId).sort();
    assert.deepEqual(referenceNotNext(source), expected);
    const result = await evaluatePatternV2({
      definition,
      events: source.toReversed(),
    });
    assert.equal(result.truncated, false);
    assert.deepEqual(candidateIds(result), expected,
      'refs=' + refs.join(','));
  }
});

test('independent oracle detects three characteristic broken notNext implementations', () => {
  const cases = [
    {
      refs: ['a', 'noise', 'b'],
      wrong: [],
      reason: 'incorrectly scan ahead to any later b',
    },
    {
      refs: ['a', 'b', 'a'],
      wrong: [0, 2],
      reason: 'allow immediately forbidden b',
    },
    {
      refs: ['a', 'noise', 'a'],
      wrong: [0],
      reason: 'silently exclude finite-snapshot tail anchor',
    },
  ];
  for (const { refs, wrong, reason } of cases) {
    const events = refs.map((ref, i) => occurrence(ref, i, reason));
    const expected = referenceNotNext(events);
    const mutation = wrong.map(i => events[i].sourceEventId).sort();
    assert.notDeepEqual(mutation, expected, reason);
  }
});

test('oracle refuses invalid or unsupported time/identity domains', () => {
  const a = occurrence('a', 0, 'invalid');
  const b = occurrence('b', 1, 'invalid');
  for (const invalid of [
    [],
    Array.from({ length: 11 }, (_, i) => occurrence('a', i, 'long')),
    [a, { ...b, sourceEventId: a.sourceEventId }],
    [a, { ...b, occurredAt: a.occurredAt }],
    [a, { ...b, occurredAt: '2026-10-13T12:01:00' }],
    [a, { ...b, occurredAt: 'garbage' }],
    [a, { ...b, clauseId: 'unmodeled' }],
    [a, { ...b, sourceEventId: '' }],
  ]) {
    assert.throws(() => referenceNotNext(invalid), TypeError);
  }
});
