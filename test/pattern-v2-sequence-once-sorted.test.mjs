import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluatePatternV2, PatternAstV2DefinitionSchema,
} from '../dist/src/intelligenceProtocol/index.js';

const count = 24;
const stamp = i => new Date(Date.UTC(2026, 9, 16, 12, 0, i)).toISOString();

function events() {
  return [
    ...Array.from({length:count}, (_,i)=>({
      clauseId:'a',sourceEventId:'a:'+i,traceId:'a:'+i,
      occurredAt:stamp(i),eventName:'a.event',
      serverId:'synthetic',provider:'conformance',
      subscriptionArguments:{},data:{},
    })),
    ...Array.from({length:count}, (_,i)=>({
      clauseId:'b',sourceEventId:'b:'+i,traceId:'b:'+i,
      occurredAt:stamp(count+i),eventName:'b.event',
      serverId:'synthetic',provider:'conformance',
      subscriptionArguments:{},data:{},
    })),
  ];
}
function definition(maxCandidates) {
  return PatternAstV2DefinitionSchema.parse({
    version:'2',partitionBy:[],
    root:{kind:'sequence',contiguity:'followedByAny',
      children:[{kind:'event',ref:'a'},{kind:'event',ref:'b'}]},
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:100},
    execution:{maxCandidates,maxSemanticEvaluations:0,maxBufferedEvents:1024},
  });
}
const pairs = result => result.matches.map(c=>[
  c.bindings.a[0].sourceEventId,c.bindings.b[0].sourceEventId,
]);

test('successors sort once rather than per left anchor, preserving finite prefix', {
  timeout:30000,
}, async () => {
  const source=events();
  const full=await evaluatePatternV2({
    definition:definition(1024),events:[...source].reverse(),
  });
  assert.equal(full.truncated,false);
  assert.equal(full.matches.length,count*count);
  const original=Array.prototype.sort;
  let sizedSorts=0;
  let limited;
  // Instrument actual Array#sort rather than relying on noisy wall-clock
  // timings. Every historical per-left compatible-array sort had length 24.
  try {
    Array.prototype.sort=function(...args) {
      if(this.length===count) sizedSorts++;
      return original.apply(this,args);
    };
    limited=await evaluatePatternV2({
      definition:definition(512),events:source,
    });
  } finally {
    Array.prototype.sort=original;
  }
  assert.equal(limited.truncated,true);
  assert.equal(limited.matches.length,512);
  assert.deepEqual(pairs(limited),pairs(full).slice(0,512));
  assert.ok(sizedSorts<10,
    'right successors must not be re-sorted for every left anchor: '+
      sizedSorts+' observed sorts of size '+count);
});
