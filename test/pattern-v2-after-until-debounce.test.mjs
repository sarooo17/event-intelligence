import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema,
  evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

function occurrence(ref, id, at) {
  return {
    clauseId: ref,
    traceId: 'operator:' + id,
    sourceEventId: id,
    eventName: ref + '.event',
    occurredAt: at,
    provider: 'contract-witness',
    serverId: 'fixture',
    subscriptionArguments: {},
    data: {},
  };
}

function definition(root) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root,
    partitionBy: [],
    selection: {
      overlap: 'allow',
      afterMatch: 'keepAll',
      maxMatchesPerEvent: 100,
    },
    execution: {
      maxCandidates: 64,
      maxSemanticEvaluations: 0,
      maxBufferedEvents: 64,
    },
  });
}

function pairEvents(aTime, bTime) {
  return [
    occurrence('a', 'a-1', aTime),
    occurrence('b', 'b-1', bTime),
  ];
}

const pairRoot = {
  kind: 'allOf',
  children: [
    { kind: 'event', ref: 'a' },
    { kind: 'event', ref: 'b' },
  ],
};

test('after is strictly greater than its bound anchor instant', async () => {
  const pattern = definition({
    kind: 'after', ref: 'b', afterRef: 'a', child: pairRoot,
  });
  const base = '2026-10-14T10:00:00.000Z';
  for (const [second, expected] of [
    ['2026-10-14T09:59:59.999Z', 0],
    [base, 0],
    ['2026-10-14T10:00:00.001Z', 1],
  ]) {
    const events = pairEvents(base, second);
    for (const arriving of [events, [...events].reverse()]) {
      const result = await evaluatePatternV2({ definition: pattern, events: arriving });
      assert.equal(result.truncated, false);
      assert.equal(result.pending.length, 0);
      assert.equal(result.matches.length, expected,
        'after b=' + second + ', arrival=' + arriving[0].clauseId);
      if (expected) assert.deepEqual(
        result.matches[0].events.map(x => x.sourceEventId), ['a-1','b-1']);
    }
  }
});

test('until includes equality and rejects a bound event strictly after its boundary', async () => {
  const pattern = definition({
    kind: 'until', ref: 'b', beforeRef: 'a', child: pairRoot,
  });
  const base = '2026-10-14T10:00:00.000Z';
  for (const [second, expected] of [
    ['2026-10-14T09:59:59.999Z', 1],
    [base, 1],
    ['2026-10-14T10:00:00.001Z', 0],
  ]) {
    const result = await evaluatePatternV2({
      definition: pattern,
      events: pairEvents(base, second),
    });
    assert.equal(result.truncated, false);
    assert.equal(result.matches.length, expected, 'until b=' + second);
  }
});

test('debounce waits until latest source + quiet interval + allowed lateness', async () => {
  const pattern = definition({
    kind: 'debounce', id: 'quiet-a', ref: 'a', forMs: 600,
    child: { kind: 'event', ref: 'a' },
  });
  const a0 = occurrence('a','a-0','2026-10-14T10:00:00.000Z');
  const a1 = occurrence('a','a-1','2026-10-14T10:00:05.000Z');
  const allowedLatenessMs = 200;
  const check = (events, now) => evaluatePatternV2({
    definition: pattern,
    events,
    now: new Date(now),
    allowedLatenessMs,
  });
  const initial = await check([a0], '2026-10-14T10:00:00.799Z');
  assert.equal(initial.matches.length, 0);
  assert.equal(initial.pending.length, 1);
  assert.equal(initial.pending[0].pendingUntil, '2026-10-14T10:00:00.800Z');

  const atFirst = await check([a0], '2026-10-14T10:00:00.800Z');
  assert.equal(atFirst.matches.length, 1);
  assert.equal(atFirst.pending.length, 0);

  // A later event moves the quiet deadline. The earlier completion cannot
  // be reused as a terminal result for the changed source corpus.
  const beforeLatest = await check([a1,a0], '2026-10-14T10:00:05.799Z');
  assert.equal(beforeLatest.matches.length, 0);
  assert.ok(beforeLatest.pending.length >= 1);
  for (const candidate of beforeLatest.pending) {
    assert.equal(candidate.pendingUntil, '2026-10-14T10:00:05.800Z');
  }
  assert.deepEqual(
    beforeLatest.pending.map(candidate =>
      candidate.bindings.a.map(source => source.sourceEventId)),
    [['a-0', 'a-1'], ['a-1']],
    'each pending debounce candidate must bind the latest ref event, even the older a0 child',
  );
  const atLatest = await check([a0,a1], '2026-10-14T10:00:05.800Z');
  assert.equal(atLatest.matches.length, 2);
  assert.deepEqual(
    atLatest.matches.map(candidate =>
      candidate.bindings.a.map(source => source.sourceEventId)),
    [['a-0', 'a-1'], ['a-1']],
    'finalized debounce must retain the same latest-source binding as pending',
  );
  assert.equal(atLatest.pending.length, 0);
  assert.equal(atLatest.truncated, false);
});
