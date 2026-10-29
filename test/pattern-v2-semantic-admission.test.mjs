import assert from 'node:assert/strict';
import test from 'node:test';
import {evaluatePatternV2,PatternAstV2DefinitionSchema} from '../dist/src/intelligenceProtocol/index.js';
function pattern(){return PatternAstV2DefinitionSchema.parse({
  version:'2',root:{kind:'semantic',id:'importance',refs:['issue'],
    instruction:'Classify the issue change',input:['issue.title'],
    matchThreshold:.8,rejectThreshold:.2,uncertain:'reject',
    execution:{cache:true,timeoutMs:1000,onUnavailable:'error'},
    child:{kind:'event',ref:'issue'}},
  partitionBy:[],selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:10},
  execution:{maxCandidates:8,maxSemanticEvaluations:4,maxBufferedEvents:8},
});}
function ev(id,ref='issue'){return{
  clauseId:ref,sourceEventId:id,traceId:'trace-'+id,
  eventName:'github.issue.updated',serverId:'github',provider:'synthetic',
  subscriptionArguments:{},occurredAt:id==='1'
    ?'2026-10-29T10:00:00.000Z':'2026-10-29T10:00:01.000Z',
  data:{title:'Important correction '+id},
};}
test('semantic admission denies before provider, declares incomplete and never scans unrelated events',async()=>{
  let calls=0,reserves=0;
  const evaluator={cacheIdentity:'host/evaluator-v1',
    async evaluate(){calls++;return {evaluator:'host/evaluator-v1',probability:.95}}};
  const approval={async reserve(request){
    reserves++;
    assert.equal(request.namespace,'tenant-a:trigger@1');
    assert.equal(request.nodeId,'importance');
    assert.equal(request.evaluatorIdentity,'host/evaluator-v1');
    assert(request.inputBytes>0);
    assert(request.instructionBytes>0);
    assert(!JSON.stringify(request).includes('Important correction'),
      'no provider value crosses the admission boundary');
    return reserves===1;
  }};
  const run=(events,semanticAdmission=approval)=>evaluatePatternV2({
    definition:pattern(),events,evaluator,semanticAdmission,
    semanticCacheNamespace:'tenant-a:trigger@1',
  });
  const noCandidate=await run([ev('ignore','unrelated')]);
  assert.equal(noCandidate.matches.length,0);
  assert.equal(reserves,0);assert.equal(calls,0);
  const mixed=await run([ev('1'),ev('2')]);
  assert.equal(mixed.semanticEvaluations,1);
  assert.equal(calls,1);assert.equal(reserves,2);
  assert.equal(mixed.truncated,true);
  assert.equal(mixed.matches.length,1);
});
test('admission failure or invalid response never invokes provider',async()=>{
  let calls=0;
  const evaluator={cacheIdentity:'host/v1',
    async evaluate(){calls++;return {evaluator:'host/v1',probability:1}}};
  for(const admission of [
    {reserve:async()=>{throw Error('budget ledger unavailable')}},
    {reserve:async()=>({allowed:true})},
  ]){
    await assert.rejects(()=>evaluatePatternV2({
      definition:pattern(),events:[ev('1')],evaluator,
      semanticAdmission:admission,
    }),/budget ledger unavailable|must return a boolean/);
  }
  assert.equal(calls,0);
  const rejected=await evaluatePatternV2({
    definition:pattern(),events:[ev('1')],evaluator,
    semanticAdmission:{reserve:async()=>false},
  });
  assert.equal(rejected.truncated,true);
  assert.deepEqual(rejected.matches,[]);
  assert.equal(calls,0);
});
test('durably cached decision skips admission and external model calls',async()=>{
  let calls=0,approved=0;
  const map=new Map();
  const opts={
    definition:pattern(),events:[ev('1')],
    semanticCacheNamespace:'t:trigger@1',
    semanticCache:{get:k=>map.get(k)??null,set:(k,v)=>map.set(k,v)},
    evaluator:{cacheIdentity:'vendor/v1',
      async evaluate(){calls++;return {evaluator:'vendor/v1',probability:.9}}},
  };
  const first=await evaluatePatternV2({...opts,semanticAdmission:{
    reserve:async()=>{approved++;return true;},
  }});
  assert.equal(first.semanticEvaluations,1);
  const cached=await evaluatePatternV2({...opts,semanticAdmission:{
    reserve:async()=>{throw Error('admission on cache hit forbidden');},
  }});
  assert.equal(cached.semanticEvaluations,0);
  assert.equal(cached.semanticCacheHits,1);
  assert.equal(calls,1);assert.equal(approved,1);
});
