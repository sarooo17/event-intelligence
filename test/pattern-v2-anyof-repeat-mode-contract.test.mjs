import assert from 'node:assert/strict';
import test from 'node:test';
import { PatternAstV2DefinitionSchema, evaluatePatternV2 }
  from '../dist/src/intelligenceProtocol/index.js';

function source(ref, index) {
  return {
    clauseId: ref, sourceEventId: ref+':'+index,
    traceId:'composition:'+ref+':'+index,
    eventName:ref+'.event',
    occurredAt:new Date(Date.UTC(2026,9,15,12,0,index)).toISOString(),
    serverId:'conformance',provider:'test',
    subscriptionArguments:{},data:{},
  };
}
function pattern(root,maxCandidates=64) {
  return PatternAstV2DefinitionSchema.parse({
    version:'2',root,partitionBy:[],
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:100},
    execution:{maxCandidates,maxSemanticEvaluations:0,maxBufferedEvents:64},
  });
}
function identities(result) {
  return result.matches.map(c=>c.events.map(e=>e.sourceEventId));
}

test('overlapping anyOf arms dedupe physical event candidates before limiting', async()=>{
  const events=[source('a',0),source('b',1),source('a',2)];
  const root={kind:'anyOf',children:[
    {kind:'event',ref:'a'},
    {kind:'event',ref:'a'},
    {kind:'event',ref:'b'},
  ]};
  for(const delivered of [events,[...events].reverse()]){
    const complete=await evaluatePatternV2({
      definition:pattern(root,3),events:delivered,
    });
    assert.equal(complete.truncated,false,
      'overlapping arms must not count duplicates as additional unique candidates');
    assert.deepEqual(identities(complete),[['a:0'],['a:2'],['b:1']]);
    const limited=await evaluatePatternV2({
      definition:pattern(root,2),events:delivered,
    });
    assert.deepEqual(identities(limited),[['a:0'],['a:2']]);
    assert.equal(limited.truncated,true,
      'third distinct b is omitted but not the duplicate a arms');
  }
});

test('greedy repeat enumerates longer matches first; lazy chooses shorter first', async()=>{
  const events=[source('x',0),source('x',1),source('x',2)];
  const root=mode=>({
    kind:'repeat',mode,contiguity:'combinations',
    min:1,max:2,child:{kind:'event',ref:'x'},
  });
  for(const delivered of [events,[...events].reverse()]){
    const greedy=await evaluatePatternV2({
      definition:pattern(root('greedy')),events:delivered,
    });
    const lazy=await evaluatePatternV2({
      definition:pattern(root('lazy')),events:delivered,
    });
    assert.equal(greedy.truncated,false);
    assert.equal(lazy.truncated,false);
    const g=identities(greedy),l=identities(lazy);
    assert.deepEqual(g.map(ids=>ids.length),[2,2,2,1,1,1]);
    assert.deepEqual(l.map(ids=>ids.length),[1,1,1,2,2,2]);
    assert.deepEqual(new Set(g.map(x=>x.join(','))),
      new Set(l.map(x=>x.join(','))),
      'mode may change ordering without changing bounded membership');
    assert.deepEqual(g[0],['x:0','x:1']);
    assert.deepEqual(l[0],['x:0']);
  }
});
