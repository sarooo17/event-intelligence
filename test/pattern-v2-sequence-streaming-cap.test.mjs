import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema, evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

function occurrence(ref, index, counter = null) {
  const item = {
    clauseId: ref,
    traceId: 'bounded-sequence:' + ref + ':' + index,
    sourceEventId: ref + ':' + index,
    eventName: ref + '.event',
    occurredAt: new Date(Date.UTC(2026, 9, 15, 12, 0, index)).toISOString(),
    serverId: 'synthetic', provider: 'conformance', data: {},
  };
  Object.defineProperty(item, 'subscriptionArguments', {
    enumerable: true,
    get() { if (counter) counter.reads++; return {}; },
  });
  return item;
}

function definition(contiguity, maxCandidates) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: {
      kind: 'sequence', contiguity,
      children: [
        { kind: 'event', ref: 'a' },
        { kind: 'event', ref: 'b' },
      ],
    },
    partitionBy: [],
    selection: {
      overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100,
    },
    execution: {
      maxCandidates, maxSemanticEvaluations: 0, maxBufferedEvents: 1024,
    },
  });
}
function pairs(result) {
  return result.matches.map(candidate => [
    candidate.bindings.a?.[0]?.sourceEventId,
    candidate.bindings.b?.[0]?.sourceEventId,
  ]);
}

test('followedByAny sequence streams first unique Cartesian completions', async () => {
  const fixture = [
    occurrence('a', 0), occurrence('a', 1),
    occurrence('b', 2), occurrence('b', 3),
  ];
  const expected = [
    ['a:0', 'b:2'], ['a:0', 'b:3'],
    ['a:1', 'b:2'], ['a:1', 'b:3'],
  ];
  for (const delivered of [fixture, [...fixture].reverse()]) {
    const low = await evaluatePatternV2({
      definition: definition('followedByAny', 2), events: delivered,
    });
    const high = await evaluatePatternV2({
      definition: definition('followedByAny', 16), events: delivered,
    });
    assert.deepEqual(pairs(high), expected);
    assert.equal(high.truncated, false);
    assert.deepEqual(pairs(low), expected.slice(0, 2));
    assert.equal(low.truncated, true);
    assert.deepEqual(low.pending, []);
  }
});

test('followedBy selects the earliest compatible successor for each anchor', async () => {
  const events = [
    occurrence('a', 0), occurrence('a', 1),
    occurrence('b', 2), occurrence('b', 3),
  ];
  for (const delivery of [events, [...events].reverse()]) {
    const high = await evaluatePatternV2({
      definition: definition('followedBy', 16), events: delivery,
    });
    assert.deepEqual(pairs(high), [
      ['a:0','b:2'], ['a:1','b:2'],
    ]);
    assert.equal(high.truncated, false);
    const low = await evaluatePatternV2({
      definition: definition('followedBy', 1), events: delivery,
    });
    assert.deepEqual(pairs(low), pairs(high).slice(0, 1));
    assert.equal(low.truncated, true);
  }
});

test('next returns incomplete rather than false complete absence when anchor is capped', async () => {
  const events = [
    occurrence('a', 0), occurrence('a', 1),
    occurrence('b', 2), occurrence('b', 3),
  ];
  for (const delivered of [events, [...events].reverse()]) {
    const low = await evaluatePatternV2({
      definition: definition('next', 1), events: delivered,
    });
    const high = await evaluatePatternV2({
      definition: definition('next', 16), events: delivered,
    });
    assert.deepEqual(pairs(low), []);
    assert.equal(low.truncated, true);
    assert.deepEqual(pairs(high), [['a:1','b:2']]);
    assert.equal(high.truncated, false);
  }
});

test('small sequence cap prevents proportional full join source-identity work', {
  timeout: 30000,
}, async () => {
  const fanout = 24;
  function corpus(counter) {
    return [
      ...Array.from({ length: fanout }, (_, i) => occurrence('a', i, counter)),
      ...Array.from({ length: fanout }, (_, i) => occurrence('b', i + fanout, counter)),
    ];
  }
  const lowCounter = { reads: 0 };
  const highCounter = { reads: 0 };
  const low = await evaluatePatternV2({
    definition: definition('followedByAny', 2), events: corpus(lowCounter),
  });
  const high = await evaluatePatternV2({
    definition: definition('followedByAny', 1024), events: corpus(highCounter),
  });
  assert.equal(low.truncated, true);
  assert.equal(high.truncated, false);
  assert.equal(low.matches.length, 2);
  assert.equal(high.matches.length, fanout * fanout);
  assert.deepEqual(pairs(low), pairs(high).slice(0, 2));
  assert.ok(highCounter.reads > lowCounter.reads * 3,
    'low cap must avoid identity work on full join; low=' +
      lowCounter.reads + ', high=' + highCounter.reads);
});
