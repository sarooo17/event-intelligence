import assert from 'node:assert/strict';
import test from 'node:test';
import { PatternAstV2DefinitionSchema, evaluatePatternV2 }
  from '../dist/src/intelligenceProtocol/index.js';

const origin=Date.UTC(2026,9,14,12,0,0);
function event(ref,id,ms) {
  return {clauseId:ref,traceId:'rate:'+id,sourceEventId:id,
    eventName:ref+'.event',occurredAt:new Date(origin+ms).toISOString(),
    serverId:'fixture',provider:'test',subscriptionArguments:{},data:{}};
}
function definition(atLeast) {
  return PatternAstV2DefinitionSchema.parse({
    version:'2',root:{
      kind:'rate',ref:'item',atLeast,perMs:1000,
      child:{kind:'event',ref:'anchor'},
    },partitionBy:[],
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:100},
    execution:{maxCandidates:100,maxSemanticEvaluations:0,maxBufferedEvents:100},
  });
}
const source=[
  event('anchor','anchor',0),
  event('item','outside',8999),
  event('item','boundary',9000),
  event('item','middle',9500),
  event('item','latest',10000),
];
test('rate includes latest-perMs boundary and binds last required source witnesses',async()=>{
  for(const delivery of [source,[...source].reverse(),
    [...source.slice(2),...source.slice(0,2)]]) {
    const inclusive=await evaluatePatternV2({
      definition:definition(3),events:delivery,
    });
    assert.equal(inclusive.truncated,false);
    assert.deepEqual(inclusive.pending,[]);
    assert.equal(inclusive.matches.length,1);
    assert.deepEqual(inclusive.matches[0].bindings.item.map(x=>x.sourceEventId),
      ['boundary','middle','latest']);

    const lastTwo=await evaluatePatternV2({
      definition:definition(2),events:delivery,
    });
    assert.equal(lastTwo.matches.length,1);
    assert.deepEqual(lastTwo.matches[0].bindings.item.map(x=>x.sourceEventId),
      ['middle','latest']);
  }
});

test('rate excludes a source 1ms outside the inclusive window',async()=>{
  const withoutBoundary=source.filter(e=>e.sourceEventId!=='boundary');
  const result=await evaluatePatternV2({
    definition:definition(3),events:withoutBoundary,
  });
  assert.equal(result.matches.length,0);
  assert.equal(result.truncated,false);
  const withOnlyBoundary=source.filter(e=>e.sourceEventId!=='middle');
  const insufficient=await evaluatePatternV2({
    definition:definition(3),events:withOnlyBoundary,
  });
  assert.equal(insufficient.matches.length,0);
  assert.equal(insufficient.truncated,false);
});
