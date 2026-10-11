import assert from 'node:assert/strict';
import test from 'node:test';
import { PatternAstV2DefinitionSchema, evaluatePatternV2 } from
  '../dist/src/intelligenceProtocol/index.js';
import { referenceRepeatIds } from
  '../scripts/evidence/reference-repeat-oracle.mjs';
import { deterministicRandom, shuffled } from
  '../scripts/evidence/reference-sequence-oracle.mjs';

// Exhaust the complete declared finite min/max domain, for each contiguity.
// Six distinct bound pairs per mode: (1,1), (1,2), (1,3), (2,2), (2,3), (3,3).
const configurations = ['combinations', 'relaxed', 'consecutive']
  .flatMap(contiguity => [1, 2, 3].flatMap(min =>
    [1, 2, 3].filter(max => max >= min)
      .map(max => ({ min, max, contiguity }))
  ));

function pattern(config, mode) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: {
      kind: 'repeat',
      child: { kind: 'event', ref: 'x' },
      ...config,
      mode,
    },
    partitionBy: [],
    selection: {
      overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100,
    },
    execution: {
      maxCandidates: 512, maxSemanticEvaluations: 0, maxBufferedEvents: 512,
    },
  });
}

function occurrence(seed, index, clauseId) {
  return {
    clauseId,
    // Reverse lexical ID ordering relative to chronological timestamps;
    // an evaluator sorting by source ID instead of event-time must fail.
    sourceEventId: 'repeat-' + seed + '-rev' + String(9 - index),
    traceId: 'repeat-trace-' + seed + '-' + index,
    eventName: clauseId + '.changed',
    serverId: 'oracle',
    provider: 'test',
    occurredAt: new Date(Date.UTC(2026, 9, 2, 12, 0, index)).toISOString(),
    subscriptionArguments: {},
    data: {},
  };
}

function signatures(result) {
  return result.matches.map((candidate) => {
    assert.deepEqual(Object.keys(candidate.bindings).sort(), ['x'],
      'repeat(event(x)) attached an unrelated reference');
    // Keep the inner event sequences chronological: openedAt/source event
    // provenance depends on candidate.events[0], not merely set membership.
    const bound = candidate.bindings.x.map(event => event.sourceEventId);
    const provenance = candidate.events.map(event => event.sourceEventId);
    assert.deepEqual(provenance, bound,
      'candidate.events must exactly match the ordered x binding, no noise or duplicates');
    assert.ok(candidate.events.every(event => event.clauseId === 'x'),
      'candidate provenance contains unrelated clause');
    return bound;
  }).sort((a, b) => a.join('|').localeCompare(b.join('|')));
}

test('repeat matches finite independent subset oracle for 250 seeds, all 18 bound/contiguity choices, 3 arrivals and both modes', async () => {
  const coverage = {
    zeroX: 0, oneX: 0, multipleX: 0, withNoise: 0,
    consecutiveX: 0, separatedX: 0, allX: 0,
  };
  for (let seed = 1; seed <= 250; seed++) {
    const random = deterministicRandom(
      (Math.imul(seed, 2654435761) ^ 0x51bca607) >>> 0
    );
    const length = 1 + ((seed - 1) % 9);
    const events = Array.from({ length }, (_, index) =>
      occurrence(seed, index, random() < 0.53 ? 'x' : 'noise')
    );
    const xCount = events.filter(event => event.clauseId === 'x').length;
    if (xCount === 0) coverage.zeroX++;
    if (xCount === 1) coverage.oneX++;
    if (xCount >= 2) coverage.multipleX++;
    if (xCount < events.length) coverage.withNoise++;
    if (xCount === events.length) coverage.allX++;
    for (let i = 1; i < events.length; i++) {
      if (events[i - 1].clauseId === 'x' && events[i].clauseId === 'x') {
        coverage.consecutiveX++;
      }
      if (i >= 2 && events[i - 2].clauseId === 'x' &&
          events[i - 1].clauseId === 'noise' && events[i].clauseId === 'x') {
        coverage.separatedX++;
      }
    }
    for (const config of configurations) {
      const expected = referenceRepeatIds(events, config);
      for (const mode of ['greedy', 'lazy']) {
        const definition = pattern(config, mode);
        for (let round = 0; round < 3; round++) {
          const result = await evaluatePatternV2({
            definition,
            events: shuffled(events, random),
            now: new Date('2026-10-03T00:00:00.000Z'),
          });
          assert.equal(result.truncated, false,
            'unexpected truncation seed=' + seed + ',mode=' + mode);
          assert.deepEqual(
            signatures(result), expected,
            'repeat differential seed=' + seed +
              ',round=' + round +
              ',mode=' + mode +
              ',contiguity=' + config.contiguity +
              ',range=' + config.min + '..' + config.max +
              ',source=' + events.map(event => event.clauseId).join(','),
          );
        }
      }
    }
  }
  for (const [category, count] of Object.entries(coverage)) {
    assert.ok(count > 0, 'repeat generator misses ' + category);
  }
});

test('independent repeat oracle distinguishes noise, x-adjacency and subset semantics', () => {
  const events = [
    occurrence(0, 0, 'x'),
    occurrence(0, 1, 'noise'),
    occurrence(0, 2, 'x'),
    occurrence(0, 3, 'x'),
  ];
  const combinations = referenceRepeatIds(events, {
    min: 2, max: 2, contiguity: 'combinations',
  });
  const relaxed = referenceRepeatIds(events, {
    min: 2, max: 2, contiguity: 'relaxed',
  });
  const consecutive = referenceRepeatIds(events, {
    min: 2, max: 2, contiguity: 'consecutive',
  });
  const ids = events.map(event => event.sourceEventId);
  assert.ok(ids[0] > ids[3],
    'fixture must make source IDs sort opposite to event time');
  const sortOuter = pairs => pairs.sort((left, right) =>
    left.join('|').localeCompare(right.join('|'))
  );
  assert.deepEqual(combinations, sortOuter([
    [ids[0], ids[2]],
    [ids[0], ids[3]],
    [ids[2], ids[3]],
  ]));
  assert.deepEqual(relaxed, sortOuter([
    [ids[0], ids[2]],
    [ids[2], ids[3]],
  ]));
  assert.deepEqual(consecutive, [[ids[2], ids[3]]);
  // Regression mutants: losing a valid across-noise pair, skipping an x
  // under relaxed contiguity, or admitting an unrelated noise as a match.
  assert.notDeepEqual(consecutive, relaxed);
  assert.notDeepEqual(relaxed, combinations);
  const admitNoise = [...combinations, [ids[1], ids[2]]];
  assert.notDeepEqual(admitNoise, combinations);
});

test('repeat differential detects reordered inner event provenance', () => {
  const a = occurrence(999, 0, 'x');
  const b = occurrence(999, 1, 'x');
  assert.deepEqual(signatures({ matches: [{
    bindings: { x: [a, b] },
    events: [a, b],
  }] }), [[a.sourceEventId, b.sourceEventId]]);
  assert.throws(() => signatures({ matches: [{
    bindings: { x: [a, b] },
    events: [b, a],
  }] }), /ordered x binding/);
  // If both binding and provenance are incorrectly reversed, the
  // independent chronological oracle still rejects the resulting order.
  assert.notDeepEqual(signatures({ matches: [{
    bindings: { x: [b, a] },
    events: [b, a],
  }] }), referenceRepeatIds([a, b], {
    min: 2, max: 2, contiguity: 'consecutive',
  }));
});

test('repeat oracle rejects ambiguous/out-of-domain corpora instead of overclaiming', () => {
  const x = occurrence(10, 0, 'x');
  const y = occurrence(10, 1, 'x');
  const config = { min: 1, max: 2, contiguity: 'combinations' };
  assert.throws(() => referenceRepeatIds([], config), /1..9/);
  assert.throws(() => referenceRepeatIds(Array.from({ length: 10 },
    (_, index) => occurrence(10, index, 'x')), config), /1..9/);
  assert.throws(() => referenceRepeatIds([x, x], config), /unique/);
  assert.throws(() => referenceRepeatIds([y, x], config), /ordered UTC/);
  assert.throws(() => referenceRepeatIds([{ ...x,
    occurredAt: '2026-10-02T12:00:00' }], config), /ordered UTC/);
  assert.throws(() => referenceRepeatIds([{ ...x,
    occurredAt: '2026-02-30T12:00:00.000Z' }], config), /ordered UTC/);
  assert.throws(() => referenceRepeatIds([{ ...x,
    clauseId: 'not-modeled' }], config), /unique/);
  assert.throws(() => referenceRepeatIds([x], { min: 0, max: 2,
    contiguity: 'combinations' }), /supported min/);
  assert.throws(() => referenceRepeatIds([x], { min: 1, max: 4,
    contiguity: 'combinations' }), /supported min/);
  assert.throws(() => referenceRepeatIds([x], { min: 1, max: 2,
    contiguity: 'unordered' }), /supported min/);
});
