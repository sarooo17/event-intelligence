import assert from 'node:assert/strict';
import test from 'node:test';
import { PatternAstV2DefinitionSchema, evaluatePatternV2 }
  from '../dist/src/intelligenceProtocol/index.js';

function event(ref,id,ms) {
  return {
    clauseId:ref,traceId:'threshold:'+id,sourceEventId:id,
    eventName:ref+'.event',occurredAt:new Date(ms).toISOString(),
    serverId:'fixture',provider:'test',subscriptionArguments:{},data:{},
  };
}
function definition(atLeast) {
  return PatternAstV2DefinitionSchema.parse({
    version:'2',
    root:{kind:'threshold',ref:'item',atLeast,
      child:{kind:'event',ref:'anchor'}},
    partitionBy:[],
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:100},
    execution:{maxCandidates:128,maxSemanticEvaluations:0,maxBufferedEvents:128},
  });
}
const origin=Date.UTC(2026,9,14,12);
const entries=[
  event('anchor','anchor',origin),
  event('item','item-1',origin+100),
  event('item','item-2',origin+200),
  event('item','item-3',origin+300),
];
test('threshold binds earliest required witnesses even if delivery is reversed',async()=>{
  for(const delivered of [entries,[...entries].reverse(),
    [...entries.slice(2),...entries.slice(0,2)]]) {
    const result=await evaluatePatternV2({
      definition:definition(2),events:delivered,
    });
    assert.equal(result.truncated,false);
    assert.deepEqual(result.pending,[]);
    assert.equal(result.matches.length,1);
    assert.deepEqual(result.matches[0].bindings.item.map(x=>x.sourceEventId),
      ['item-1','item-2']);
    assert.deepEqual(result.matches[0].events.map(x=>x.sourceEventId),
      ['anchor','item-1','item-2']);
  }
});
test('threshold never treats a partial count as a complete match',async()=>{
  for(const [corpus,n,expected] of [
    [[entries[0],entries[1]],2,0],
    [[entries[0],entries[1],entries[2]],2,1],
    [entries,4,0],
    [entries,3,1],
  ]) {
    const result=await evaluatePatternV2({
      definition:definition(n),events:corpus,
    });
    assert.equal(result.truncated,false);
    assert.equal(result.matches.length,expected);
    if(expected)assert.equal(result.matches[0].bindings.item.length,n);
  }
});
