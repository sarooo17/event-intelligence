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
  referenceNestedNotPresentPairs,
} from '../scripts/evidence/reference-nested-notpresent-oracle.mjs';

const start = Date.UTC(2026, 9, 13, 12, 0, 0);
const definition = PatternAstV2DefinitionSchema.parse({
  version: '2',
  root: {
    kind: 'notPresent',
    ref: 'b',
    child: {
      kind: 'allOf',
      children: [
        { kind: 'event', ref: 'a' },
        { kind: 'event', ref: 'c' },
      ],
    },
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

function occurrence(ref, index, seed) {
  return {
    clauseId: ref,
    traceId: 'notpresent:' + seed + ':trace:' + index,
    // Chronological ordering deliberately opposes lexicographic event IDs.
    sourceEventId: 'notpresent:' + seed + ':id:' +
      String(30 - index).padStart(2, '0'),
    eventName: ref + '.event',
    occurredAt: new Date(start + 173 * index).toISOString(),
    provider: 'oracle',
    serverId: 'bounded',
    subscriptionArguments: {},
    data: {},
  };
}

function actualPairs(evaluation) {
  return evaluation.matches.map(candidate => {
    assert.equal(candidate.events.length, 2);
    const a = candidate.bindings.a?.[0];
    const c = candidate.bindings.c?.[0];
    assert.equal(a?.clauseId, 'a');
    assert.equal(c?.clauseId, 'c');
    assert.equal(candidate.bindings.b, undefined,
      'forbidden b must never be bound as a matched source');
    assert.deepEqual(
      candidate.events.map(event => event.sourceEventId),
      [a, c]
        .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt))
        .map(event => event.sourceEventId),
      'matched evidence must remain chronological',
    );
    return [a.sourceEventId, c.sourceEventId];
  }).sort((left, right) => left.join('|').localeCompare(right.join('|')));
}

test('notPresent(allOf(a,c)) matches independent bounded 250-seed oracle across shuffled delivery', async () => {
  const refs = ['a', 'b', 'c', 'noise'];
  const coverage = {
    noA: 0, noC: 0, noB: 0, withB: 0, both: 0,
    forbiddenInside: 0, forbiddenOutside: 0,
  };
  for (let seed = 1; seed <= 250; seed++) {
    const random = deterministicRandom(
      (Math.imul(seed, 2654435761) ^ 0xa79e13c7) >>> 0);
    const length = 1 + (seed - 1) % 9;
    const source = Array.from({ length }, (_, index) =>
      occurrence(refs[Math.floor(random() * refs.length)], index, seed));
    const expected = referenceNestedNotPresentPairs(source);
    const count = ref => source.filter(event => event.clauseId === ref).length;
    if (!count('a')) coverage.noA++;
    if (!count('c')) coverage.noC++;
    if (!count('b')) coverage.noB++;
    if (count('b')) coverage.withB++;
    if (count('a') && count('c')) coverage.both++;
    for (const a of source.filter(e => e.clauseId === 'a')) {
      for (const c of source.filter(e => e.clauseId === 'c')) {
        const begin = Math.min(Date.parse(a.occurredAt), Date.parse(c.occurredAt));
        const end = Math.max(Date.parse(a.occurredAt), Date.parse(c.occurredAt));
        const bInside = source.some(e => e.clauseId === 'b' &&
          Date.parse(e.occurredAt) >= begin && Date.parse(e.occurredAt) <= end);
        if (bInside) coverage.forbiddenInside++;
        else if (count('b')) coverage.forbiddenOutside++;
      }
    }
    for (let round = 0; round < 3; round++) {
      const evaluation = await evaluatePatternV2({
        definition,
        events: shuffled(source, random),
        now: new Date('2026-10-14T00:00:00Z'),
      });
      assert.equal(evaluation.truncated, false, 'seed=' + seed);
      assert.equal(evaluation.pending.length, 0, 'finite snapshot has no pending negative finality');
      assert.deepEqual(actualPairs(evaluation), expected,
        'seed=' + seed + ', round=' + round +
        ', refs=' + source.map(event => event.clauseId).join(','));
    }
  }
  for (const [name, hits] of Object.entries(coverage)) {
    assert.ok(hits > 0, 'seed generator lacks ' + name + ' coverage');
  }
});

test('nested notPresent independently rejects only pairs spanning a forbidden b', async () => {
  for (const [refs, expectedIndices] of [
    [['a', 'b', 'c'], []],
    [['a', 'noise', 'c'], [[0, 2]]],
    [['a', 'c', 'b'], [[0, 1]]],
    [['b', 'a', 'c'], [[1, 2]]],
    [['c', 'b', 'a'], []],
    [['a', 'c', 'b', 'a', 'c'], [[0, 1], [3, 4]]],
  ]) {
    const events = refs.map((ref, i) => occurrence(ref, i, 'boundary'));
    const expected = expectedIndices.map(([a, c]) =>
      [events[a].sourceEventId, events[c].sourceEventId])
      .sort((x, y) => x.join('|').localeCompare(y.join('|')));
    assert.deepEqual(referenceNestedNotPresentPairs(events), expected);
    const result = await evaluatePatternV2({
      definition, events: events.toReversed(),
    });
    assert.equal(result.truncated, false);
    assert.deepEqual(actualPairs(result), expected, refs.join(','));
  }
});

test('bounded nested oracle distinguishes global veto, ignoring inner forbidden and rejecting noise', () => {
  for (const { refs, mutated } of [
    { refs: ['a', 'c', 'b'], mutated: [] },
    { refs: ['a', 'b', 'c'], mutated: [[0, 2]] },
    { refs: ['a', 'noise', 'c'], mutated: [] },
  ]) {
    const events = refs.map((ref, i) => occurrence(ref, i, 'mutant'));
    const expected = referenceNestedNotPresentPairs(events);
    const wrong = mutated.map(([a, c]) =>
      [events[a].sourceEventId, events[c].sourceEventId]);
    assert.notDeepEqual(wrong, expected, refs.join(','));
  }
});

test('independent nested oracle fails closed on unsupported identity/time domains', () => {
  const a = occurrence('a', 0, 'invalid');
  const c = occurrence('c', 1, 'invalid');
  for (const invalid of [
    [],
    Array.from({ length: 10 }, (_, i) => occurrence('a', i, 'long')),
    [a, { ...c, sourceEventId: a.sourceEventId }],
    [a, { ...c, occurredAt: a.occurredAt }],
    [a, { ...c, occurredAt: '2026-10-13T12:00:01' }],
    [a, { ...c, occurredAt: 'invalid' }],
    [a, { ...c, clauseId: 'unsupported' }],
    [a, { ...c, sourceEventId: '' }],
  ]) {
    assert.throws(() => referenceNestedNotPresentPairs(invalid), TypeError);
  }
});
