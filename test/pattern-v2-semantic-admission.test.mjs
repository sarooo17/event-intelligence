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

test('monotonic batch wall-time budget refuses a model call after slow shared admission',async()=>{
  let providerCalls=0;
  const evaluation=await evaluatePatternV2({
    definition:pattern(),events:[ev('1')],
    evaluator:{cacheIdentity:'deadline-v1',async evaluate(){
      providerCalls++;
      return {evaluator:'deadline-v1',probability:.99};
    }},
    maxBatchElapsedMs:20,
    semanticAdmission:{async reserve(){
      await new Promise(resolve=>setTimeout(resolve,65));
      return true;
    }},
  });
  assert.equal(providerCalls,0,'reserve after deadline must never invoke provider');
  assert.equal(evaluation.truncated,true,'deadline overrun is incomplete, not rejection');
  assert.deepEqual(evaluation.matches,[]);
  for(const invalid of [0,9,-1,600001,1.5,NaN,'1000']) {
    await assert.rejects(()=>evaluatePatternV2({
      definition:pattern(),events:[ev('1')],maxBatchElapsedMs:invalid,
    }),/Invalid semantic batch elapsed-time budget/);
  }
});

test('batch elapsed cap includes 50k-event preprocessing, not just evaluator time',async()=>{
  let providerCalls=0,approvalCalls=0;
  const events=Array.from({length:49999},(_,i)=>({
    ...ev('noise-'+i,'noise'),
    occurredAt:new Date(Date.parse('2026-10-29T08:00:00.000Z')+i).toISOString(),
  }));
  events.push(ev('1'));
  const result=await evaluatePatternV2({
    definition:pattern(),events,
    evaluator:{cacheIdentity:'high-cardinality-clock',async evaluate(){
      providerCalls++;
      return {evaluator:'high-cardinality-clock',probability:.99};
    }},
    semanticAdmission:{reserve:()=>{approvalCalls++;return true;}},
    maxBatchElapsedMs:10,
  });
  assert.equal(providerCalls,0,'sorting/indexing must count against batch deadline');
  assert.equal(approvalCalls,0,'no admission after pre-evaluation deadline');
  assert.equal(result.truncated,true);
});
test('batch timeout yields explicit incomplete result, not thrown semantic node failure',async()=>{
  let providerCalls=0;
  const result=await evaluatePatternV2({
    definition:pattern(),events:[ev('1')],
    maxBatchElapsedMs:20,
    evaluator:{cacheIdentity:'batch-timeout-fixture',async evaluate(){
      providerCalls++;
      await new Promise(resolve=>setTimeout(resolve,85));
      return {evaluator:'batch-timeout-fixture',probability:.99};
    }},
  });
  assert.equal(providerCalls,1,'one already-reserved in-flight evaluation');
  assert.equal(result.truncated,true);
  assert.equal(result.semanticEvaluations,1);
  assert.deepEqual(result.matches,[]);
});

test('short per-node timeout still throws when batch deadline has ample time',async()=>{
  const ast=pattern();
  const node={...ast.root,execution:{...ast.root.execution,timeoutMs:20}};
  let calls=0;
  await assert.rejects(()=>evaluatePatternV2({
    definition:{...ast,root:node},
    events:[ev('1')],maxBatchElapsedMs:1000,
    evaluator:{cacheIdentity:'node-short-timeout',async evaluate(){
      calls++;await new Promise(resolve=>setTimeout(resolve,90));
      return {evaluator:'node-short-timeout',probability:.99};
    }},
  }),/Semantic node importance timed out after 20ms/);
  assert.equal(calls,1);
});

test('host-neutral evaluator sees cooperative AbortSignal when cumulative batch deadline ends',async()=>{
  let calls=0,aborted=0;
  const result=await evaluatePatternV2({
    definition:pattern(),events:[ev('1')],
    maxBatchElapsedMs:25,
    evaluator:{cacheIdentity:'cooperative-batch-abort',
      async evaluate(request,options){
        calls++;
        assert.equal(typeof request.instruction,'string');
        assert(options?.signal instanceof AbortSignal);
        return new Promise((resolve,reject)=>{
          options.signal.addEventListener('abort',()=>{
            aborted++;
            reject(new Error('host evaluator abort acknowledged'));
          },{once:true});
        });
      },
    },
  });
  assert.equal(calls,1);
  assert.equal(aborted,1,'host provider adapter receives abort signal');
  assert.equal(result.truncated,true,'batch budget exhaustion remains incomplete');
  assert.deepEqual(result.matches,[]);
});
test('node timeout also signals cooperative provider abort without changing error contract',async()=>{
  const ast=pattern();
  let aborts=0;
  await assert.rejects(()=>evaluatePatternV2({
    definition:{...ast,root:{...ast.root,
      execution:{...ast.root.execution,timeoutMs:25}}},
    events:[ev('1')],maxBatchElapsedMs:1000,
    evaluator:{cacheIdentity:'cooperative-node-abort',
      async evaluate(request,options){
        assert(options?.signal instanceof AbortSignal);
        return new Promise((resolve,reject)=>{
          options.signal.addEventListener('abort',()=>{
            aborts++;
            reject(new Error('abort acknowledged'));
          },{once:true});
        });
      }},
  }),/Semantic node importance timed out after 25ms/);
  assert.equal(aborts,1);
});
