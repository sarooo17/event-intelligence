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
  referenceNotFollowedBy,
} from '../scripts/evidence/reference-negation-oracle.mjs';

const start = Date.UTC(2026, 9, 1, 12, 0, 0);
const withinMs = 400;
const allowedLatenessMs = 350;
const definition = PatternAstV2DefinitionSchema.parse({
  version: '2',
  root: {
    kind: 'notFollowedBy',
    id: 'no-b-after-a',
    child: { kind: 'event', ref: 'a' },
    forbidden: { kind: 'event', ref: 'b' },
    withinMs,
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

function event(ref, index, prefix) {
  return {
    clauseId: ref,
    traceId: prefix + ':trace-' + index,
    sourceEventId: prefix + ':event-' + index,
    eventName: ref + '.event',
    occurredAt: new Date(start + index * 200).toISOString(),
    provider: 'reference',
    serverId: 'oracle',
    subscriptionArguments: {},
    data: {},
  };
}

function ids(candidates) {
  return candidates
    .map((candidate) => candidate.bindings.a?.[0]?.sourceEventId)
    .sort();
}

test('notFollowedBy matches independent absence oracle for 250 seeds, all lengths and three clock points', async () => {
  for (let seed = 1; seed <= 250; seed += 1) {
    const random = deterministicRandom(seed * 2791);
    const length = 1 + ((seed - 1) % 10);
    const source = Array.from({ length }, (_, i) => {
      const kind = ['a', 'b', 'noise'][Math.floor(random() * 3)];
      return event(kind, i, 's' + seed);
    });
    // The oracle must not assume arrival order. Compare three independent
    // delivery shuffles at each of three deterministic wall-clock points.
    for (const nowMs of [start + 100, start + 1100, start + 4000]) {
      const expected = referenceNotFollowedBy(source, {
        withinMs,
        allowedLatenessMs,
        nowMs,
      });
      for (let round = 0; round < 3; round += 1) {
        const result = await evaluatePatternV2({
          definition,
          events: shuffled(source, random),
          now: new Date(nowMs),
          allowedLatenessMs,
        });
        assert.equal(result.truncated, false, 'seed=' + seed);
        assert.deepEqual(
          { matches: ids(result.matches), pending: ids(result.pending) },
          expected,
          'seed=' + seed + ' round=' + round + ' at=' + nowMs +
          ' source=' + source.map((item) => item.clauseId).join(','),
        );
      }
    }
  }
});

test('forbidden event exactly at deadline blocks, but an event after deadline does not', async () => {
  const onDeadline = [
    event('a', 0, 'boundary'),
    event('b', 2, 'boundary'),
  ];
  const afterDeadline = [
    event('a', 0, 'boundary'),
    { ...event('b', 2, 'boundary'), occurredAt:
      new Date(start + withinMs + 1).toISOString() },
  ];
  for (const [events, blocked] of [
    [onDeadline, true],
    [afterDeadline, false],
  ]) {
    const nowMs = start + withinMs + allowedLatenessMs;
    const expected = referenceNotFollowedBy(events, {
      withinMs, allowedLatenessMs, nowMs,
    });
    const actual = await evaluatePatternV2({
      definition, events, now: new Date(nowMs), allowedLatenessMs,
    });
    assert.equal(actual.matches.length, blocked ? 0 : 1);
    assert.deepEqual(ids(actual.matches), expected.matches);
  }
});

test('oracle rejects unsupported timing parameters', () => {
  assert.throws(
    () => referenceNotFollowedBy([], {
      withinMs: -1, allowedLatenessMs: 0, nowMs: start,
    }),
    /Invalid bounded negative-window/,
  );
});

test('forbidden event at exactly the anchor timestamp does not block a future-only window', async () => {
  const source = [
    event('a', 0, 'same-time'),
    {
      ...event('b', 1, 'same-time'),
      occurredAt: new Date(start).toISOString(),
    },
  ];
  const nowMs = start + withinMs + allowedLatenessMs;
  const expected = referenceNotFollowedBy(source, {
    withinMs, allowedLatenessMs, nowMs,
  });
  for (const order of [source, [...source].reverse()]) {
    const actual = await evaluatePatternV2({
      definition,
      events: order,
      now: new Date(nowMs),
      allowedLatenessMs,
    });
    assert.deepEqual(ids(actual.matches), expected.matches);
    assert.deepEqual(ids(actual.pending), expected.pending);
    assert.equal(actual.matches.length, 1);
  }
});

test('negative window stays pending until finalAt - 1ms and finalizes at finalAt', async () => {
  const source = [event('a', 0, 'final-boundary')];
  const finalAt = start + withinMs + allowedLatenessMs;
  for (const nowMs of [finalAt - 1, finalAt]) {
    const expected = referenceNotFollowedBy(source, {
      withinMs, allowedLatenessMs, nowMs,
    });
    const actual = await evaluatePatternV2({
      definition,
      events: source,
      now: new Date(nowMs),
      allowedLatenessMs,
    });
    assert.deepEqual(
      { matches: ids(actual.matches), pending: ids(actual.pending) },
      expected,
    );
    assert.equal(actual.pending.length, nowMs < finalAt ? 1 : 0);
    assert.equal(actual.matches.length, nowMs < finalAt ? 0 : 1);
  }
});
