import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema,
  evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';
import { referenceAllOfPairs } from '../scripts/evidence/reference-allof-oracle.mjs';
import { deterministicRandom, shuffled } from '../scripts/evidence/reference-sequence-oracle.mjs';

const definition = PatternAstV2DefinitionSchema.parse({
  version: '2',
  root: {
    kind: 'allOf',
    children: [
      { kind: 'event', ref: 'a' },
      { kind: 'event', ref: 'b' },
    ],
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

function inputEvent(seed, index, ref) {
  return {
    clauseId: ref,
    sourceEventId: `allof-${seed}-${index}`,
    traceId: `trace-${seed}-${index}`,
    eventName: `${ref}.changed`,
    serverId: 'oracle', provider: 'test',
    occurredAt: new Date(Date.UTC(2026, 9, 1, 12, 0, index)).toISOString(),
    subscriptionArguments: {}, data: {},
  };
}

function actualPairs(result) {
  return result.matches.map(match => [
    match.bindings.a[0].sourceEventId,
    match.bindings.b[0].sourceEventId,
  ]).sort((a, b) => a.join('|').localeCompare(b.join('|')));
}

test('allOf independently matches 250 seeded Cartesian corpora under 3 arrival permutations', async () => {
  const coverage = { noA: 0, noB: 0, both: 0, neither: 0 };
  for (let seed = 1; seed <= 250; seed++) {
    // Consecutive raw LCG seeds share their first output bucket; scramble
    // seeds so the first event can be a, b or noise.
    const random = deterministicRandom(
      (Math.imul(seed, 2654435761) ^ 0x85ebca6b) >>> 0,
    );
    const length = 1 + ((seed - 1) % 9);
    const events = Array.from({ length }, (_, i) => inputEvent(
      seed, i, ['a', 'b', 'noise'][Math.floor(random() * 3)],
    ));
    const hasA = events.some(event => event.clauseId === 'a');
    const hasB = events.some(event => event.clauseId === 'b');
    if (!hasA) coverage.noA++;
    if (!hasB) coverage.noB++;
    if (hasA && hasB) coverage.both++;
    if (!hasA && !hasB) coverage.neither++;
    const expected = referenceAllOfPairs(events);
    for (let round = 0; round < 3; round++) {
      const arrival = shuffled(events, random);
      const result = await evaluatePatternV2({
        definition, events: arrival,
        now: new Date('2026-10-02T00:00:00.000Z'),
      });
      assert.equal(result.truncated, false, `seed=${seed},round=${round}`);
      assert.deepEqual(actualPairs(result), expected,
        `allOf differential mismatch seed=${seed},round=${round},sequence=${events.map(x => x.clauseId).join(',')}`);
    }
  }
  for (const [caseName, observed] of Object.entries(coverage)) {
    assert.ok(observed > 0, 'missing seeded coverage for ' + caseName);
  }
});

test('allOf oracle rejects unsupported or duplicate-id corpora rather than overclaiming', () => {
  assert.throws(() => referenceAllOfPairs([]), /1\.\.9/);
  assert.throws(() => referenceAllOfPairs(Array(10).fill({ clauseId: 'a', sourceEventId: 'x' })), /1\.\.9/);
  assert.throws(() => referenceAllOfPairs([
    { clauseId: 'a', sourceEventId: 'same' },
    { clauseId: 'b', sourceEventId: 'same' },
  ]), /unique/);
  assert.throws(() => referenceAllOfPairs([{ clauseId: 'semantic', sourceEventId: 's' }]), /supported/);
  assert.throws(() => referenceAllOfPairs([{ clauseId: 'a', sourceEventId: '' }]), /unique supported/);
  assert.throws(() => referenceAllOfPairs([
    { clauseId: 'a', sourceEventId: 'valid' },
    { clauseId: 'b', sourceEventId: '' },
  ]), /unique supported/);
});
