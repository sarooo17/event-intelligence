import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema,
  evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';
import {
  deterministicRandom,
  referenceSequencePairs,
  shuffled,
} from '../scripts/evidence/reference-sequence-oracle.mjs';

function pattern(contiguity) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: {
      kind: 'sequence',
      contiguity,
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
}

function sourceEvent(id, ref, index) {
  return {
    clauseId: ref,
    traceId: 'oracle:' + id,
    sourceEventId: id,
    eventName: ref + '.event',
    occurredAt: new Date(Date.UTC(2026, 9, 1, 12, 0, 0, index * 100)).toISOString(),
    provider: 'oracle',
    serverId: 'reference',
    subscriptionArguments: {},
    data: {},
  };
}

function pairs(result) {
  return result.matches.map((candidate) => [
    candidate.bindings.a[0].sourceEventId,
    candidate.bindings.b[0].sourceEventId,
  ]).sort((left, right) => left.join('|').localeCompare(right.join('|')));
}

for (const contiguity of ['next', 'followedBy']) {
  test('event-time sequence ' + contiguity + ' matches independent bounded oracle across 250 seeded streams', async () => {
    const definition = pattern(contiguity);
    for (let seed = 1; seed <= 250; seed += 1) {
      const random = deterministicRandom(seed);
      const length = 1 + Math.floor(random() * 8);
      const chronological = Array.from({ length }, (_, i) => {
        const choice = Math.floor(random() * 3);
        return sourceEvent('s' + seed + 'e' + i, ['a', 'b', 'noise'][choice], i);
      });
      const expected = referenceSequencePairs(chronological, contiguity);
      for (let round = 0; round < 3; round += 1) {
        const shuffledInput = shuffled(chronological, random);
        const actual = await evaluatePatternV2({
          definition,
          events: shuffledInput,
          now: new Date('2026-10-02T00:00:00.000Z'),
        });
        assert.equal(actual.truncated, false, 'seed=' + seed);
        assert.deepEqual(
          pairs(actual),
          expected,
          'oracle disagreement (contiguity=' + contiguity +
            ', seed=' + seed + ', round=' + round + ', input=' +
            chronological.map((item) => item.clauseId).join(',') + ')',
        );
      }
    }
  });
}

test('bounded oracle rejects unsupported semantics instead of pretending to validate them', () => {
  assert.throws(
    () => referenceSequencePairs([], 'greedy'),
    /Unknown reference contiguity/,
  );
});
