import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePatternV2, PatternAstV2DefinitionSchema }
  from '../dist/src/intelligenceProtocol/index.js';

const base=Date.UTC(2026,9,16,12,0,0);
function event(ref,i) {
  return {
    clauseId:ref, sourceEventId:'work:'+ref+':'+i,
    traceId:'work:'+ref+':'+i, eventName:ref+'.event',
    occurredAt:new Date(base+i*10).toISOString(),
    serverId:'synthetic',provider:'oracle',
    subscriptionArguments:{},data:{},
  };
}
function definition(root, maxCandidates=512) {
  return PatternAstV2DefinitionSchema.parse({
    version:'2',root,partitionBy:[],
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:100},
    execution:{maxCandidates,maxBufferedEvents:100000,
      maxSemanticEvaluations:0},
  });
}
function snapshot(result) {
  return {
    matches:result.matches.map(c=>c.events.map(e=>e.sourceEventId)),
    pending:result.pending.map(c=>c.events.map(e=>e.sourceEventId)),
    truncated:result.truncated,
  };
}

test('overlapping nested allOf stops bounded dead-end work and never reports definitive no-match', {
  timeout:30000,
},async()=>{
  const pair={kind:'allOf',children:[
    {kind:'event',ref:'a'},{kind:'event',ref:'b'},
  ]};
  const node={kind:'allOf',children:[pair,pair]};
  // Every inner a/b pair shares the same "a" physical source, so the
  // final allOf has no valid disjoint pair: maxCandidates does not
  // bound work unless we count each failed merge attempt.
  for(const count of [20,512]) {
    const events=[event('a',0),
      ...Array.from({length:count},(_,i)=>event('b',i+1))];
    const result=await evaluatePatternV2({
      definition:definition(node,512),events,
    });
    assert.deepEqual(result.matches,[]);
    assert.deepEqual(result.pending,[]);
    assert.equal(result.truncated,count===512,
      'large dead-end scan must be explicitly inconclusive');
  }
});

test('global preflight never sorts or treats oversized input as absent', {
  timeout:10000,
},async()=>{
  const x=event('x',0);
  const events=Array(50_001).fill(x);
  const result=await evaluatePatternV2({
    definition:definition({
      kind:'notPresent',ref:'forbidden',
      child:{kind:'event',ref:'x'},
    },16),events,
  });
  assert.deepEqual(snapshot(result),{
    matches:[],pending:[],truncated:true,
  });
});

test('deeply nested and oversized ASTs are incomplete without stack overflow', {
  timeout:10000,
},async()=>{
  let deep={kind:'event',ref:'x'};
  for(let i=0;i<140;i++) deep={kind:'optional',mode:'lazy',child:deep};
  // Use a structurally valid definition object directly to test the
  // runtime preflight without invoking the recursive Zod parser first.
  const policy=definition({kind:'event',ref:'x'},16);
  const tooDeep=await evaluatePatternV2({
    definition:{...policy,root:deep},events:[event('x',0)],
  });
  assert.deepEqual(snapshot(tooDeep),{
    matches:[],pending:[],truncated:true,
  });
  const wide=await evaluatePatternV2({
    definition:{...policy,root:{
      kind:'anyOf',
      children:Array.from({length:4097},()=>({kind:'event',ref:'x'})),
    }},
    events:[event('x',0)],
  });
  assert.deepEqual(snapshot(wide),{
    matches:[],pending:[],truncated:true,
  });
});

test('anyOf streaming retains stable first distinct prefix and does not flag duplicates', {
  timeout:10000,
},async()=>{
  const single=event('x',0);
  const duplicateArms={kind:'anyOf',children:Array.from(
    {length:128},()=>({kind:'event',ref:'x'}))};
  const identical=await evaluatePatternV2({
    definition:definition(duplicateArms,2),events:[single],
  });
  assert.deepEqual(snapshot(identical),{
    matches:[[single.sourceEventId]],pending:[],truncated:false,
  });
  const diverse={kind:'anyOf',children:Array.from(
    {length:80},(_,i)=>({kind:'event',ref:'ref'+i}))};
  const result=await evaluatePatternV2({
    definition:definition(diverse,8),
    events:Array.from({length:80},(_,i)=>event('ref'+i,i)),
  });
  assert.deepEqual(result.matches.map(x=>x.events[0].sourceEventId),
    Array.from({length:8},(_,i)=>'work:ref'+i+':'+i));
  assert.equal(result.truncated,true);
});

test('negative operators fail closed on incomplete child evidence',async()=>{
  for(const negative of ['notPresent','absence']) {
    const child={kind:'event',ref:'x'};
    const root=negative==='notPresent'
      ?{kind:'notPresent',ref:'missing',child}
      :{kind:'absence',id:'quiet',ref:'missing',afterRef:'x',
        forMs:1000,child};
    const result=await evaluatePatternV2({
      definition:definition(root,1),
      events:[event('x',0),event('x',1)],
      now:new Date(base+5000),
    });
    assert.deepEqual(snapshot(result),{
      matches:[],pending:[],truncated:true,
    },negative+' cannot assert a negative result from truncated child evidence');
  }
});
