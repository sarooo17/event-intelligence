import assert from 'node:assert/strict';
import test from 'node:test';
import { PatternAstV2DefinitionSchema, evaluatePatternV2 }
  from '../dist/src/intelligenceProtocol/index.js';

const origin = Date.UTC(2026, 9, 15, 12, 0, 0);
function event(ref, id, ms, serverId = 'fixture') {
  return {
    clauseId: ref,
    traceId: 'replay:' + serverId + ':' + ref + ':' + id,
    sourceEventId: id,
    eventName: ref + '.event',
    occurredAt: new Date(origin + ms).toISOString(),
    provider: 'fixture',
    serverId,
    subscriptionArguments: { feed: 'stable' },
    data: {},
  };
}
function duplicate(e) {
  return { ...e, traceId: 'replayed-copy:' + e.traceId };
}
const anchor = event('anchor', 'anchor', 0);
function definition(kind, atLeast) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: {
      kind,
      ref: 'item',
      atLeast,
      ...(kind === 'rate' ? { perMs: 1000 } : {}),
      child: { kind: 'event', ref: 'anchor' },
    },
    partitionBy: [],
    selection: {
      overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100,
    },
    execution: {
      maxCandidates: 64, maxSemanticEvaluations: 0, maxBufferedEvents: 64,
    },
  });
}
async function run(kind, atLeast, events) {
  return evaluatePatternV2({ definition: definition(kind, atLeast), events });
}
function sourceIds(result) {
  return result.matches.flatMap(candidate =>
    candidate.bindings.item.map(item => item.serverId + ':' + item.sourceEventId));
}

for (const kind of ['threshold', 'rate']) {
  test(kind + ' rejects replay copies as multiple independent occurrences', async () => {
    const one = event('item', 'one', 1000);
    const source = [anchor, one, duplicate(one), duplicate(one)];
    for (const delivery of [source, [...source].reverse()]) {
      const denied = await run(kind, 2, delivery);
      assert.deepEqual(denied.matches, [],
        'one physical source repeated in the inbox cannot satisfy atLeast:2');
      assert.equal(denied.truncated, false);
      assert.deepEqual(denied.pending, []);
      const admitted = await run(kind, 1, delivery);
      assert.equal(admitted.matches.length, 1);
      assert.deepEqual(sourceIds(admitted), ['fixture:one']);
      assert.equal(admitted.truncated, false);
    }
  });

  test(kind + ' counts distinct physical sources and binds exact unique evidence', async () => {
    const one = event('item', 'one', 500);
    const two = event('item', 'two', 1000);
    const source = [anchor, one, duplicate(one), two, duplicate(two)];
    for (const delivery of [source, [...source].reverse()]) {
      const exact = await run(kind, 2, delivery);
      assert.equal(exact.matches.length, 1);
      assert.deepEqual(sourceIds(exact), ['fixture:one', 'fixture:two']);
      assert.equal(exact.matches[0].bindings.item.length, 2);
      assert.equal(exact.truncated, false);
      const tooMany = await run(kind, 3, delivery);
      assert.deepEqual(tooMany.matches, []);
      assert.equal(tooMany.truncated, false);
    }
  });

  test(kind + ' preserves identical source IDs owned by different servers', async () => {
    const alpha = event('item', 'shared-id', 500, 'alpha');
    const beta = event('item', 'shared-id', 600, 'beta');
    const source = [anchor, alpha, duplicate(alpha), beta];
    for (const delivery of [source, [...source].reverse()]) {
      const result = await run(kind, 2, delivery);
      assert.equal(result.matches.length, 1);
      assert.deepEqual(sourceIds(result), [
        'alpha:shared-id', 'beta:shared-id',
      ]);
      assert.equal(result.truncated, false);
    }
  });
}

test('rate retains the last two distinct sources across a replay-heavy inclusive window', async () => {
  const earliest = event('item', 'boundary', 1000);
  const middle = event('item', 'middle', 1500);
  const latest = event('item', 'latest', 2000);
  const source = [anchor, earliest, middle, latest,
    duplicate(middle), duplicate(latest), duplicate(latest)];
  const result = await run('rate', 2, source);
  assert.equal(result.matches.length, 1);
  assert.deepEqual(sourceIds(result), ['fixture:middle', 'fixture:latest']);
  const three = await run('rate', 3, source);
  assert.deepEqual(sourceIds(three), [
    'fixture:boundary', 'fixture:middle', 'fixture:latest',
  ]);
  const outside = await run('rate', 3, source.map(e =>
    e.sourceEventId === 'boundary'
      ? { ...e, occurredAt: new Date(origin + 999).toISOString() }
      : e));
  assert.deepEqual(outside.matches, []);
  assert.equal(outside.truncated, false);
});
