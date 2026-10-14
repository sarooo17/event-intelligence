import assert from 'node:assert/strict';
import test from 'node:test';
import { PatternAstV2DefinitionSchema, evaluatePatternV2 }
  from '../dist/src/intelligenceProtocol/index.js';

function event(ref, id, index, data) {
  return {
    clauseId: ref, traceId: 'distinct:' + id, sourceEventId: id,
    eventName: ref + '.event', occurredAt: new Date(
      Date.UTC(2026, 9, 14, 12, 0, index)).toISOString(),
    provider: 'fixture', serverId: 'conformance',
    subscriptionArguments: {}, data,
  };
}
function pattern(minimum) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: {
      kind: 'distinct', ref: 'item', path: 'category.value',
      atLeast: minimum, child: { kind: 'event', ref: 'anchor' },
    },
    partitionBy: [],
    selection: { overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100 },
    execution: { maxCandidates: 128, maxSemanticEvaluations: 0, maxBufferedEvents: 128 },
  });
}
const events = [
  event('anchor','anchor',0,{}),
  event('item','str-first',1,{category:{value:'x'}}),
  event('item','str-duplicate',2,{category:{value:'x'}}),
  event('item','invalid-object',3,{category:{value:{x:true}}}),
  event('item','invalid-null',4,{category:{value:null}}),
  event('item','num',5,{category:{value:7}}),
  event('item','bool',6,{category:{value:false}}),
  event('item','num-duplicate',7,{category:{value:7}}),
];

test('distinct binds first primitive witnesses in event-time order, not arrival order', async () => {
  for (const ordered of [events, [...events].reverse(), [...events.slice(3), ...events.slice(0,3)]]) {
    const result = await evaluatePatternV2({
      definition: pattern(3), events: ordered,
      now: new Date('2026-10-14T13:00:00.000Z'),
    });
    assert.equal(result.truncated, false);
    assert.deepEqual(result.pending, []);
    assert.equal(result.matches.length, 1);
    assert.deepEqual(result.matches[0].bindings.item.map(e => e.sourceEventId),
      ['str-first', 'num', 'bool']);
    assert.deepEqual(result.matches[0].events.map(e => e.sourceEventId),
      ['anchor', 'str-first', 'num', 'bool']);
  }
});

test('distinct never treats duplicate or nonprimitive paths as qualifying values', async () => {
  const insufficient = await evaluatePatternV2({
    definition: pattern(4), events,
  });
  assert.deepEqual(insufficient.matches, []);
  assert.equal(insufficient.truncated, false);
  const noQualifying = await evaluatePatternV2({
    definition: pattern(1), events: [events[0],events[3],events[4]],
  });
  assert.deepEqual(noQualifying.matches, []);
  assert.equal(noQualifying.truncated, false);
});

test('distinct primitive types remain separate and minimum threshold is inclusive', async () => {
  const data = [
    event('anchor','anchor',0,{}),
    event('item','numeric',1,{category:{value:1}}),
    event('item','string',2,{category:{value:'1'}}),
    event('item','boolean',3,{category:{value:true}}),
  ];
  const result = await evaluatePatternV2({ definition: pattern(3), events:data });
  assert.deepEqual(result.matches[0].bindings.item.map(x => x.sourceEventId),
    ['numeric','string','boolean']);
});
