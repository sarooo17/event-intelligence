import assert from 'node:assert/strict';
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

test('billion-hop window is bounded for positive and negative membership', {
  timeout:12000,
},async()=>{
  const size=1_000_000_000;
  const compatible=await evaluate(0,size-1,size,1,0);
  assert.equal(compatible.length,1,
    'a valid billion-hop range must not require a billion loop iterations');
  const incompatible=await evaluate(0,size+1,size,1,0);
  assert.deepEqual(incompatible,[],
    'a nonmatching billion-hop range must terminate without linear scanning');
});
