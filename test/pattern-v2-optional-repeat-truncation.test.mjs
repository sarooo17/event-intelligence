import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema, evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

function ev(ref, n) {
  return {
    clauseId: ref,
    traceId: 'budget:' + ref + ':' + n,
    sourceEventId: ref + ':' + n,
    eventName: ref + '.event',
    occurredAt: new Date(Date.UTC(2026, 9, 15, 8, 0, 0, n * 100)).toISOString(),
    serverId: 'conformance', provider: 'test', subscriptionArguments: {}, data: {},
  };
}
function pattern(root, maxCandidates) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root,
    partitionBy: [],
    selection: {
      overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100,
    },
    execution: {
      maxCandidates, maxSemanticEvaluations: 0, maxBufferedEvents: 64,
    },
  });
}
function identities(result) {
  return result.matches.map(c => c.events.map(e => e.sourceEventId));
}

for (const mode of ['greedy', 'lazy']) {
  test('optional ' + mode + ' must expose truncated output at cap=1', async () => {
    const source = [ev('x', 0), ev('x', 1)];
    const root = { kind: 'optional', mode, child: { kind: 'event', ref: 'x' } };
    for (const delivered of [source, [...source].reverse()]) {
      const low = await evaluatePatternV2({
        definition: pattern(root, 1), events: delivered,
      });
      const high = await evaluatePatternV2({
        definition: pattern(root, 8), events: delivered,
      });
      assert.equal(low.truncated, true,
        'dropped optional branches must never look like complete no-match');
      assert.equal(high.truncated, false);
      assert.equal(low.matches.length, 1);
      assert.equal(high.matches.length, 3);
      assert.deepEqual(low.pending, []);
      assert.deepEqual(identities(low), mode === 'greedy' ? [['x:0']] : [[]]);
      assert.deepEqual(
        new Set(identities(high).map(ids => ids.join(','))),
        new Set(['x:0','x:1','']),
      );
    }
  });
}

test('lazy optional in a nested sequence cannot silently discard real completions', async () => {
  const source = [ev('a', 0), ev('b', 1), ev('b', 2)];
  const root = {
    kind: 'sequence', contiguity: 'next',
    children: [
      { kind: 'event', ref: 'a' },
      { kind: 'optional', mode: 'lazy', child: { kind: 'event', ref: 'b' } },
    ],
  };
  const limited = await evaluatePatternV2({
    definition: pattern(root, 1), events: source,
  });
  const complete = await evaluatePatternV2({
    definition: pattern(root, 8), events: source,
  });
  assert.equal(limited.truncated, true);
  assert.equal(complete.truncated, false);
  assert.ok(identities(complete).some(ids => ids.join(',') === 'a:0,b:1'));
  assert.deepEqual(identities(limited), [['a:0']]);
});

test('repeat exhaustive and limited results keep explicit cap diagnostics', async () => {
  const source = [ev('x',0),ev('x',1),ev('x',2)];
  const root = {
    kind: 'repeat', min: 1, max: 2,
    mode: 'greedy', contiguity: 'combinations',
    child: {kind: 'event',ref: 'x'},
  };
  const limited = await evaluatePatternV2({
    definition: pattern(root,1), events:source,
  });
  const complete = await evaluatePatternV2({
    definition: pattern(root,64), events:source,
  });
  assert.equal(limited.truncated,true);
  assert.equal(complete.truncated,false);
  assert.ok(complete.matches.length > limited.matches.length);
});
