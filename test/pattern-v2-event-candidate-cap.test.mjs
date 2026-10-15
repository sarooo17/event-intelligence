import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema, evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

function source(ref, id, at, counter=null) {
  const e={
    clauseId:ref,traceId:'event-budget:'+id,sourceEventId:id,
    eventName:ref+'.event',occurredAt:at,
    provider:'fixture',serverId:'host-1',data:{},
  };
  Object.defineProperty(e,'subscriptionArguments',{
    enumerable:true,
    get(){if(counter)counter.calls++;return {};},
  });
  return e;
}
function pattern(root, maxCandidates) {
  return PatternAstV2DefinitionSchema.parse({
    version:'2',root,partitionBy:[],
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:100},
    execution:{maxCandidates,maxSemanticEvaluations:0,maxBufferedEvents:512},
  });
}
function ids(result) {
  return result.matches.map(c=>c.events.map(e=>e.sourceEventId));
}

test('event node limits unique candidates before root materialization',async()=>{
  const time=index=>new Date(Date.UTC(2026,9,15,12,0,index)).toISOString();
  const lowCalls={calls:0},highCalls={calls:0};
  const events=(counter)=>Array.from({length:96},(_,i)=>
    source('x','x:'+i,time(i),counter));
  const low=await evaluatePatternV2({
    definition:pattern({kind:'event',ref:'x'},2),events:events(lowCalls),
  });
  const high=await evaluatePatternV2({
    definition:pattern({kind:'event',ref:'x'},128),events:events(highCalls),
  });
  assert.deepEqual(ids(low),[['x:0'],['x:1']]);
  assert.equal(low.truncated,true);
  assert.equal(high.truncated,false);
  assert.equal(high.matches.length,96);
  assert.deepEqual(ids(low),ids(high).slice(0,2));
  assert.ok(highCalls.calls > lowCalls.calls*5,
    'low cap must not construct all 96 event candidates; low='+
      lowCalls.calls+', high='+highCalls.calls);
});

test('later calendar-filtered match is never mislabeled complete no-match',async()=>{
  const events=[
    source('x','early-1','2026-10-15T10:00:00.000Z'),
    source('x','early-2','2026-10-15T10:01:00.000Z'),
    source('x','real-match','2026-10-15T13:00:00.000Z'),
  ];
  const root={kind:'calendar',
    child:{kind:'event',ref:'x'},
    ref:'x',timezone:'UTC',after:'12:00',
  };
  for(const delivery of [events,[...events].reverse()]){
    const low=await evaluatePatternV2({
      definition:pattern(root,1),events:delivery,
    });
    const high=await evaluatePatternV2({
      definition:pattern(root,8),events:delivery,
    });
    assert.deepEqual(ids(low),[]);
    assert.equal(low.truncated,true,
      'a hidden later real match cannot yield a conclusive empty result');
    assert.deepEqual(ids(high),[['real-match']]);
    assert.equal(high.truncated,false);
  }
});

test('physical duplicates do not consume distinct candidate budget slots',async()=>{
  const first=source('x','physical-id','2026-10-15T12:00:00.000Z');
  const copy={...first,traceId:'replayed-duplicate'};
  const second=source('x','other-id','2026-10-15T12:00:01.000Z');
  const result=await evaluatePatternV2({
    definition:pattern({kind:'event',ref:'x'},2),
    events:[copy,second,first],
  });
  assert.deepEqual(ids(result),[['physical-id'],['other-id']]);
  assert.equal(result.truncated,false,
    'replayed physical duplicates are not independent candidates');
});

test('negative branches fail closed when candidate cap hides a later blocker',async()=>{
  const sources=[
    source('b','b-old','2026-10-15T12:00:00.000Z'),
    source('a','a-anchor','2026-10-15T12:00:01.000Z'),
    source('b','b-blocker','2026-10-15T12:00:02.000Z'),
  ];
  for(const negative of [
    {kind:'notNext',child:{kind:'event',ref:'a'},
      forbidden:{kind:'event',ref:'b'}},
    {kind:'notFollowedBy',id:'no-next-b',
      child:{kind:'event',ref:'a'},forbidden:{kind:'event',ref:'b'},
      withinMs:5000},
  ]) {
    for(const delivered of [sources,[...sources].reverse()]){
      const low=await evaluatePatternV2({
        definition:pattern(negative,1),events:delivered,
        now:new Date('2026-10-15T12:00:10.000Z'),
      });
      const complete=await evaluatePatternV2({
        definition:pattern(negative,8),events:delivered,
        now:new Date('2026-10-15T12:00:10.000Z'),
      });
      assert.deepEqual(ids(low),[],
        'a hidden blocker cannot produce a positive negative-pattern match');
      assert.deepEqual(low.pending,[],
        'incomplete evidence must not schedule a potentially false negative');
      assert.equal(low.truncated,true);
      assert.deepEqual(ids(complete),[]);
      assert.equal(complete.truncated,false);
    }
  }
});

test('negative branches with incomplete nonblocking evidence emit no matches',async()=>{
  const sources=[
    source('b','b-old','2026-10-15T12:00:00.000Z'),
    source('a','a-anchor','2026-10-15T12:00:01.000Z'),
    // The immediate successor is neutral. Without it, b-late would
    // truly block notNext even when outside the notFollowedBy deadline.
    source('noise','neutral-next','2026-10-15T12:00:02.000Z'),
    source('b','b-late','2026-10-15T12:00:30.000Z'),
  ];
  for(const negative of [
    {kind:'notNext',child:{kind:'event',ref:'a'},
      forbidden:{kind:'event',ref:'b'}},
    {kind:'notFollowedBy',id:'no-near-b',withinMs:5000,
      child:{kind:'event',ref:'a'},
      forbidden:{kind:'event',ref:'b'}},
  ]) {
    const incomplete=await evaluatePatternV2({
      definition:pattern(negative,1),events:sources,
      now:new Date('2026-10-15T12:01:00.000Z'),
    });
    const complete=await evaluatePatternV2({
      definition:pattern(negative,8),events:sources,
      now:new Date('2026-10-15T12:01:00.000Z'),
    });
    assert.deepEqual(ids(incomplete),[],
      'even an ultimately valid negative remains unsafe until forbidden evidence is complete');
    assert.equal(incomplete.truncated,true);
    assert.deepEqual(ids(complete),[['a-anchor']]);
    assert.equal(complete.truncated,false);
  }
});
