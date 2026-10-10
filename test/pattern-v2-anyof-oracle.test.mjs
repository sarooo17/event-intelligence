import assert from 'node:assert/strict';
import test from 'node:test';
import { PatternAstV2DefinitionSchema, evaluatePatternV2 } from
  '../dist/src/intelligenceProtocol/index.js';
import { referenceAnyOfIds } from
  '../scripts/evidence/reference-anyof-oracle.mjs';
import { deterministicRandom, shuffled } from
  '../scripts/evidence/reference-sequence-oracle.mjs';

const definition = PatternAstV2DefinitionSchema.parse({
  version: '2',
  root: { kind: 'anyOf', children: [
    { kind: 'event', ref: 'a' }, { kind: 'event', ref: 'b' },
  ] },
  partitionBy: [],
  selection: {
    overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100,
  },
  execution: {
    maxCandidates: 512, maxSemanticEvaluations: 0, maxBufferedEvents: 512,
  },
});

function event(seed, index, ref) {
  return {
    clauseId: ref,
    sourceEventId: 'anyof-' + seed + '-' + index,
    traceId: 'anyof-trace-' + seed + '-' + index,
    eventName: ref + '.changed',
    serverId: 'oracle',
    provider: 'test',
    occurredAt: new Date(Date.UTC(2026, 9, 1, 12, 0, index)).toISOString(),
    subscriptionArguments: {}, data: {},
  };
}

test('anyOf matches 250 independent seeded corpora under three permutations', async () => {
  const coverage = { noA: 0, noB: 0, both: 0, neither: 0 };
  for (let seed = 1; seed <= 250; seed++) {
    const random = deterministicRandom(
      (Math.imul(seed, 2654435761) ^ 0x9e3779b9) >>> 0
    );
    const length = 1 + ((seed - 1) % 9);
    const events = Array.from({ length }, (_, i) =>
      event(seed, i, ['a', 'b', 'noise'][Math.floor(random() * 3)])
    );
    const hasA = events.some(x => x.clauseId === 'a');
    const hasB = events.some(x => x.clauseId === 'b');
    if (!hasA) coverage.noA++;
    if (!hasB) coverage.noB++;
    if (hasA && hasB) coverage.both++;
    if (!hasA && !hasB) coverage.neither++;
    const expected = referenceAnyOfIds(events);
    for (let round = 0; round < 3; round++) {
      const arrival = shuffled(events, random);
      const result = await evaluatePatternV2({
        definition, events: arrival,
        now: new Date('2026-10-02T00:00:00.000Z'),
      });
      assert.equal(result.truncated, false,
        'seed=' + seed + ',round=' + round);
      const actual = result.matches
        .map(candidate => candidate.events[0]?.sourceEventId)
        .sort();
      assert.deepEqual(actual, expected,
        'anyOf oracle mismatch seed=' + seed + ',round=' + round +
        ',data=' + events.map(x => x.clauseId).join(','));
    }
  }
  for (const [label, total] of Object.entries(coverage)) {
    assert.ok(total > 0, 'anyOf corpus lacks ' + label);
  }
});

test('independent anyOf oracle detects deliberately seeded regression mutants', () => {
  const cases = [
    event(1, 0, 'a'), event(1, 1, 'b'),
    event(1, 2, 'noise'), event(1, 3, 'a'),
  ];
  const expected = referenceAnyOfIds(cases);
  // Mutant A: treat OR as only the first branch.
  const mutantOnlyA = cases.filter(x => x.clauseId === 'a')
    .map(x => x.sourceEventId).sort();
  // Mutant B: accidentally include irrelevant events as matches.
  const mutantAcceptNoise = cases.map(x => x.sourceEventId).sort();
  // Mutant C: incorrectly deduplicate all occurrences by clause ID.
  const mutantDistinctClause = ['a', 'b'].map(ref =>
    cases.find(x => x.clauseId === ref).sourceEventId).sort();
  for (const [label, mutant] of [
    ['drops second branch', mutantOnlyA],
    ['accepts noise', mutantAcceptNoise],
    ['dedupes valid occurrences', mutantDistinctClause],
  ]) {
    assert.notDeepEqual(mutant, expected, 'oracle failed to detect ' + label);
  }
});

test('anyOf oracle refuses invalid evidence instead of expanding its claims', () => {
  assert.throws(() => referenceAnyOfIds([]), /1\.\.9/);
  assert.throws(() => referenceAnyOfIds(Array.from({ length: 10 },
    (_,i) => ({ sourceEventId:String(i), clauseId:'a' }))), /1\.\.9/);
  assert.throws(() => referenceAnyOfIds([
    { sourceEventId:'same', clauseId:'a' },
    { sourceEventId:'same', clauseId:'b' },
  ]), /unique/);
  assert.throws(() => referenceAnyOfIds([
    { sourceEventId:'x', clauseId:'semantic' },
  ]), /unique/);
});
