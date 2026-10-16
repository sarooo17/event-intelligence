import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluatePatternV2, PatternAstV2DefinitionSchema,
} from '../dist/src/intelligenceProtocol/index.js';

function event(ref,index) {
  return {
    clauseId:ref,sourceEventId:ref+':'+index,traceId:'repeat-cap:'+ref+':'+index,
    occurredAt:new Date(Date.UTC(2026,9,16,9,0,0,index)).toISOString(),
    eventName:ref+'.event',serverId:'source',provider:'conformance',
    subscriptionArguments:{},data:{},
  };
}
function definition(root,maxCandidates,buffer=1024) {
  return PatternAstV2DefinitionSchema.parse({
    version:'2',root,partitionBy:[],
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:100},
    execution:{maxCandidates,maxSemanticEvaluations:0,maxBufferedEvents:buffer},
  });
}

test('repeat with impossible minimum is a complete empty result, not an explosion', {
  timeout:30000,
}, async () => {
  const events=Array.from({length:20},(_,i)=>event('x',i));
  for(const delivered of [events,[...events].reverse()]) {
    const result=await evaluatePatternV2({
      definition:definition({
        kind:'repeat',min:512,max:512,mode:'greedy',
        contiguity:'combinations',child:{kind:'event',ref:'x'},
      },512),events:delivered,
    });
    assert.deepEqual(result.matches,[]);
    assert.deepEqual(result.pending,[]);
    assert.equal(result.truncated,false,
      'a proven impossible minimum must not claim a budget failure');
  }
});

test('repeat exploration cap reports incomplete zero matches for overlapping units', {
  timeout:30000,
}, async () => {
  // Every allOf(a,b) candidate shares the same a source, so no pair of
  // candidates is disjoint. Yet a naive search explores O(n^2) dead ends
  // before it may legitimately conclude no-match.
  const events=[event('a',0),
    ...Array.from({length:100},(_,i)=>event('b',i+1))];
  const root={kind:'repeat',min:2,max:2,mode:'greedy',
    contiguity:'combinations',
    child:{kind:'allOf',children:[
      {kind:'event',ref:'a'},{kind:'event',ref:'b'},
    ]},
  };
  for(const delivered of [events,[...events].reverse()]){
    const low=await evaluatePatternV2({
      definition:definition(root,100),events:delivered,
    });
    const high=await evaluatePatternV2({
      definition:definition(root,512),events:delivered,
    });
    assert.deepEqual(low.matches,[]);
    assert.deepEqual(high.matches,[]);
    assert.equal(low.truncated,true,
      'exhausted exploration cannot masquerade as complete no-match');
    assert.equal(high.truncated,false,
      'larger exploration budget completes this bounded no-match corpus');
  }
});

test('deep repeat never overflows the JS call stack or claims false completeness', {
  timeout:30000,
}, async () => {
  const events=Array.from({length:513},(_,i)=>event('x',i));
  const result=await evaluatePatternV2({
    definition:definition({kind:'repeat',min:513,max:513,
      mode:'greedy',contiguity:'consecutive',
      child:{kind:'event',ref:'x'}},10000),
    events,
  });
  assert.deepEqual(result.matches,[]);
  assert.equal(result.truncated,true,
    'depth-limited search must not emit a definitive empty match result');
});
