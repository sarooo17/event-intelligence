import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema, evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

function definition(maxCandidates) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: {
      kind: 'allOf',
      children: [
        {kind: 'event', ref:'a'},
        {kind: 'event', ref:'b'},
      ],
    },
    partitionBy: [],
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:100},
    execution:{maxCandidates,maxSemanticEvaluations:0,maxBufferedEvents:4096},
  });
}
function event(ref, i, touched=null) {
  const value = {
    clauseId:ref,traceId:ref+'-trace-'+i,
    sourceEventId:ref+':'+i,eventName:ref+'.event',
    occurredAt:new Date(Date.UTC(2026,9,15,12,0,i)).toISOString(),
    serverId:'fixture',provider:'conformance',data:{},
  };
  Object.defineProperty(value,'subscriptionArguments',{
    enumerable:true,
    get() { if(touched) touched.calls++; return {}; },
  });
  return value;
}
function pairs(result) {
  return result.matches.map(candidate=>[
    candidate.bindings.a?.[0]?.sourceEventId,
    candidate.bindings.b?.[0]?.sourceEventId,
  ]);
}

test('bounded allOf returns first unique Cartesian witnesses and marks truncation', async()=>{
  const events=[
    event('a',0),event('a',1),event('a',2),
    event('b',3),event('b',4),event('b',5),
  ];
  const expected=events.filter(x=>x.clauseId==='a').flatMap(a=>
    events.filter(x=>x.clauseId==='b').map(b=>
      [a.sourceEventId,b.sourceEventId]));
  assert.equal(expected.length,9);
  for(const delivered of [events,[...events].reverse()]){
    const low=await evaluatePatternV2({definition:definition(2),events:delivered});
    const high=await evaluatePatternV2({definition:definition(16),events:delivered});
    assert.equal(low.truncated,true);
    assert.equal(high.truncated,false);
    assert.deepEqual(pairs(low),expected.slice(0,2));
    assert.deepEqual(pairs(high),expected);
    assert.deepEqual(low.pending,[]);
  }
});

test('low-cap joins avoid traversing the entire otherwise valid Cartesian product', {
  timeout:30000,
},async()=>{
  const fanout=32;
  const lowCounter={calls:0};
  const highCounter={calls:0};
  const sources=touched=>[
    ...Array.from({length:fanout},(_,i)=>event('a',i,touched)),
    ...Array.from({length:fanout},(_,i)=>event('b',i+fanout,touched)),
  ];
  const low=await evaluatePatternV2({
    definition:definition(2), events:sources(lowCounter),
  });
  const high=await evaluatePatternV2({
    definition:definition(2048), events:sources(highCounter),
  });
  assert.equal(low.truncated,true);
  assert.equal(high.truncated,false);
  assert.equal(low.matches.length,2);
  assert.equal(high.matches.length,fanout*fanout);
  assert.deepEqual(pairs(low),pairs(high).slice(0,2));
  assert.ok(highCounter.calls > lowCounter.calls*4,
    'bounded run must avoid work proportional to full '+fanout+'x'+fanout+' Cartesian expansion; '+
      'low='+lowCounter.calls+', high='+highCounter.calls);
});
