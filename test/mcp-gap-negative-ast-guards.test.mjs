import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePatternV2, PatternAstV2DefinitionSchema }
  from '../dist/src/intelligenceProtocol/index.js';
import { incompleteNegativeRefs } from '../dist/src/composite/deliveryGap.js';

const time=Date.UTC(2026,9,16,12,0,0);
const anchor={
  clauseId:'a',sourceEventId:'a:one',traceId:'a:one',
  eventName:'job.started',serverId:'upstream',provider:'mcp',
  occurredAt:new Date(time).toISOString(),
  subscriptionArguments:{},data:{},
};
function definition(root){
  return PatternAstV2DefinitionSchema.parse({
    version:'2',root,partitionBy:[],
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:10},
    execution:{maxCandidates:64,maxSemanticEvaluations:0,maxBufferedEvents:64},
  });
}
const a={kind:'event',ref:'a'};
const b={kind:'event',ref:'b'};
const negativeRoots=[
  {kind:'notPresent',ref:'b',child:a},
  {kind:'notNext',child:a,forbidden:b},
  {kind:'notFollowedBy',id:'no-failure',child:a,
    forbidden:b,withinMs:1000},
  {kind:'absence',id:'absence',ref:'b',afterRef:'a',
    child:a,forMs:1000},
];

test('all four negative operators are inconclusive under missing forbidden evidence',async()=>{
  for(const root of negativeRoots){
    const d=definition(root);
    const complete=await evaluatePatternV2({
      definition:d,events:[anchor],now:new Date(time+3000),
    });
    assert.equal(complete.truncated,false,root.kind);
    assert.equal(complete.matches.length,1,root.kind);
    const incomplete=await evaluatePatternV2({
      definition:d,events:[anchor],now:new Date(time+3000),
      incompleteSourceRefs:new Set(['b']),
    });
    assert.equal(incomplete.truncated,true,root.kind);
    assert.equal(incomplete.matches.length,0,root.kind);
    assert.equal(incomplete.pending.length,0,root.kind);
  }
});

test('a source gap does not block a fully independent positive anyOf branch',async()=>{
  const root={
    kind:'anyOf',children:[
      {kind:'notFollowedBy',id:'quiet',child:a,
        forbidden:b,withinMs:1000},
      a,
    ],
  };
  const result=await evaluatePatternV2({
    definition:definition(root),events:[anchor],
    now:new Date(time+3000),incompleteSourceRefs:new Set(['b']),
  });
  assert.equal(result.truncated,true);
  assert.equal(result.matches.length,1);
  assert.equal(result.matches[0].events[0].sourceEventId,'a:one');
});

test('gap source selection distinguishes connection, server, name, args and refs',()=>{
  const d={pattern:definition(negativeRoots[2]),
    clauses:[
      {id:'a',serverId:'upstream',event:'job.started',arguments:{}},
      {id:'b',serverId:'upstream',event:'job.failed',
        arguments:{environment:'prod',nested:{a:1,b:2}}},
    ]};
  const make=(serverId,eventName,args,connectionId='real')=>({
    connectionId,serverId,eventName,arguments:args,gapUnresolved:true,
  });
  const proper=make('upstream','job.failed',
    {nested:{b:2,a:1},environment:'prod'});
  assert.deepEqual([...incompleteNegativeRefs(d,[proper],['real'])],['b']);
  for(const wrong of [
    make('other','job.failed',proper.arguments),
    make('upstream','other.event',proper.arguments),
    make('upstream','job.failed',{environment:'staging',nested:{a:1,b:2}}),
    make('upstream','job.failed',proper.arguments,'unrelated'),
  ]){
    assert.equal(incompleteNegativeRefs(d,[wrong],['real']).size,0);
  }
  assert.equal(incompleteNegativeRefs(d,[
    {...proper,gapUnresolved:false,truncated:false}],['real']).size,0);
});
