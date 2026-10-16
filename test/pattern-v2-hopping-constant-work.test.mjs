import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema, evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

const epoch=Date.UTC(2026,9,16,12,0,0);
function event(id,millis) {
  return {
    clauseId:'x', sourceEventId:'hopping:'+id,
    traceId:'hopping:'+id, eventName:'x.event',
    occurredAt:new Date(epoch+millis).toISOString(),
    provider:'finite-oracle',serverId:'synthetic',
    subscriptionArguments:{},data:{},
  };
}
function definition(sizeMs,hopMs,offsetMs) {
  return PatternAstV2DefinitionSchema.parse({
    version:'2',partitionBy:[],
    root:{kind:'window',window:{type:'hopping',sizeMs,hopMs,offsetMs},
      child:{kind:'repeat',min:2,max:2,mode:'greedy',
        contiguity:'combinations',child:{kind:'event',ref:'x'}}},
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:10},
    execution:{maxCandidates:32,maxSemanticEvaluations:0,maxBufferedEvents:32},
  });
}
// Slow reference for FINITE small integer ranges only. It is deliberately
// independent of the production closed-form hopping-window implementation.
function bruteForce(a,b,size,hop,offset) {
  const earliest=Math.min(a,b), latest=Math.max(a,b);
  let candidates=0;
  const min=earliest-2500, max=latest+2500;
  const first=Math.ceil((min-offset)/hop)*hop+offset;
  for(let start=first;start<=max;start+=hop) {
    candidates++;
    if(start<=earliest && latest<start+size) return true;
  }
  assert.ok(candidates<=7001,'reference corpus must remain finite');
  return false;
}
async function evaluate(a,b,size,hop,offset) {
  const result=await evaluatePatternV2({
    definition:definition(size,hop,offset),
    events:[event('a',a),event('b',b)].reverse(),
  });
  assert.equal(result.truncated,false);
  assert.deepEqual(result.pending,[]);
  return result.matches.map(x=>x.events.map(e=>e.sourceEventId).sort());
}

test('hopping matches independent finite lattice across offsets and boundaries', {
  timeout:30000,
},async()=>{
  for(let seed=1;seed<=140;seed++){
    const a=(seed*37)%700,b=a+(seed*23)%500;
    const size=1+(seed*29)%550;
    const hop=1+(seed*13)%100;
    const offset=(seed*17)%200;
    const expected=bruteForce(epoch+a,epoch+b,size,hop,offset);
    const got=await evaluate(a,b,size,hop,offset);
    assert.equal(got.length,Number(expected),
      'seed='+seed+' size='+size+' hop='+hop+' offset='+offset);
  }
});

test('huge offsets preserve the exact lattice across the Unix epoch',async()=>{
  const a={...event('a',0),occurredAt:new Date(0).toISOString()};
  const b={...event('b',1),occurredAt:new Date(1).toISOString()};
  const result=await evaluatePatternV2({
    definition:definition(3,3,Number.MAX_SAFE_INTEGER),
    events:[a,b],
  });
  assert.equal(result.truncated,false);
  assert.deepEqual(result.matches,[],
    'a rounded offset must not invent a containing hopping window');
});

test('billion-hop adversary finishes before an externally enforced subprocess deadline', {
  timeout:15000,
},()=>{
  // A node:test timeout cannot interrupt a blocked synchronous loop.
  // The OS-level child-process timeout enforces the work bound even if
  // production regresses to the previous size/hop-iteration algorithm.
  const child=`import { evaluatePatternV2 } from './dist/src/intelligenceProtocol/index.js';
    const base=Date.UTC(2026,9,16,12);
    const mk=(i,ms)=>({
      clauseId:'x',sourceEventId:'x:'+i,traceId:'x:'+i,eventName:'x',
      occurredAt:new Date(base+ms).toISOString(),
      serverId:'test',provider:'test',subscriptionArguments:{},data:{}
    });
    const policy={
      version:'2',partitionBy:[],
      root:{kind:'window',window:{type:'hopping',
        sizeMs:1000000000,hopMs:1,offsetMs:0},
        child:{kind:'repeat',min:2,max:2,mode:'greedy',
          contiguity:'combinations',child:{kind:'event',ref:'x'}}},
      selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:10},
      execution:{maxCandidates:32,maxBufferedEvents:32,maxSemanticEvaluations:0},
    };
    for(const [end,count] of [[999999999,1],[1000000001,0]]) {
      const r=await evaluatePatternV2({
        definition:policy,events:[mk('a',0),mk('b',end)],
      });
      if(r.truncated||r.matches.length!==count) process.exit(7);
    }`;
  assert.doesNotThrow(()=>execFileSync(process.execPath,
    ['--input-type=module','-e',child],{
      timeout:3000,stdio:'pipe',encoding:'utf8',
    }),
  'hopping evaluation must complete without O(size/hop) scanning');
});
