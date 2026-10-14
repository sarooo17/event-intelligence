import assert from 'node:assert/strict';
import test from 'node:test';
import { PatternAstV2DefinitionSchema, evaluatePatternV2 }
  from '../dist/src/intelligenceProtocol/index.js';

const start=Date.UTC(2026,9,14,12,0,0);
function event(ref,index,ms) {
  return {
    clauseId:ref,traceId:'cap:'+ref+':'+index,
    sourceEventId:ref+':'+index,eventName:ref+'.event',
    occurredAt:new Date(start+ms).toISOString(),
    provider:'test',serverId:'reference',
    subscriptionArguments:{},data:{},
  };
}
function config(root,maxCandidates) {
  return PatternAstV2DefinitionSchema.parse({
    version:'2',root,partitionBy:[],
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:100},
    execution:{maxCandidates,maxSemanticEvaluations:0,maxBufferedEvents:512},
  });
}
function matches(result) {
  return result.matches.map(c=>c.events.map(x=>x.sourceEventId));
}
const window={type:'within',sizeMs:1};

test('nested allOf/window cap never misreports an omitted real match as complete absence',async()=>{
  const source=[
    ...Array.from({length:11},(_,i)=>event('a',i,i*20000)),
    event('a',11,400000),
    ...Array.from({length:11},(_,i)=>event('b',i,500000+i*20000)),
    event('b',11,400001),
  ];
  // Independent Cartesian reference: only a:11 and b:11 have a time
  // separation <= 1ms. Earlier candidate combinations cannot satisfy it.
  const expected=[];
  for(const a of source.filter(x=>x.clauseId==='a')){
    for(const b of source.filter(x=>x.clauseId==='b')){
      if(Math.abs(Date.parse(a.occurredAt)-Date.parse(b.occurredAt))<=1){
        expected.push([a.sourceEventId,b.sourceEventId]);
      }
    }
  }
  assert.deepEqual(expected,[['a:11','b:11']]);
  const root={kind:'window',window,child:{kind:'allOf',
    children:[{kind:'event',ref:'a'},{kind:'event',ref:'b'}]}};
  for(const events of [source,[...source].reverse()]){
    const low=await evaluatePatternV2({
      definition:config(root,3),events,
    });
    const high=await evaluatePatternV2({
      definition:config(root,512),events,
    });
    assert.equal(low.truncated,true,
      'a missed match from an exhausted intermediate join must be inconclusive');
    assert.deepEqual(matches(low),[]);
    assert.deepEqual(low.pending,[]);
    assert.equal(high.truncated,false);
    assert.deepEqual(matches(high),[['a:11','b:11']]);
  }
});

test('nested repeat/window budget preserves explicit incomplete status',async()=>{
  const source=[
    ...Array.from({length:7},(_,i)=>event('x',i,i*20000)),
    event('x',7,350000),event('x',8,350001),
  ];
  const expected=[];
  for(let i=0;i<source.length;i++){
    for(let j=i+1;j<source.length;j++){
      if(Date.parse(source[j].occurredAt)-Date.parse(source[i].occurredAt)<=1){
        expected.push([source[i].sourceEventId,source[j].sourceEventId]);
      }
    }
  }
  assert.deepEqual(expected,[['x:7','x:8']]);
  const root={kind:'window',window,child:{
    kind:'repeat',child:{kind:'event',ref:'x'},
    min:2,max:3,mode:'lazy',contiguity:'combinations',
  }};
  for(const events of [source,[...source].reverse()]){
    const low=await evaluatePatternV2({
      definition:config(root,2),events,
    });
    const high=await evaluatePatternV2({
      definition:config(root,512),events,
    });
    assert.equal(low.truncated,true);
    assert.deepEqual(matches(low),[]);
    assert.equal(high.truncated,false);
    assert.deepEqual(matches(high),[['x:7','x:8']]);
  }
});
