import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema, evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

const origin=Date.UTC(2026,9,16,12,0,0);
const windows=[
  {type:'within',sizeMs:400},
  {type:'sliding',sizeMs:400},
  {type:'tumbling',sizeMs:600,offsetMs:0},
  {type:'tumbling',sizeMs:600,offsetMs:137},
  {type:'hopping',sizeMs:600,hopMs:300,offsetMs:0},
  {type:'hopping',sizeMs:600,hopMs:300,offsetMs:137},
  {type:'session',gapMs:400},
  {type:'count',size:3},
];

function rng(seed) {
  let n=(Math.imul(seed,2654435761)^0x91cd37e2)>>>0;
  return () => {
    n=(Math.imul(n,1664525)+1013904223)>>>0;
    return n/4294967296;
  };
}
function sample(seed) {
  const random=rng(seed);
  const length=3+(seed%7);
  return Array.from({length},(_,i)=>({
    clauseId:i===0||i===1?'x':random()<0.53?'x':'noise',
    sourceEventId:'nested:'+seed+':'+String(99-i),
    traceId:'nested:'+seed+':'+i,
    eventName:'nested.event',serverId:'independent-oracle',
    provider:'synthetic',subscriptionArguments:{},data:{},
    occurredAt:new Date(origin+i*200).toISOString(),
  }));
}
function config(window,mode) {
  return PatternAstV2DefinitionSchema.parse({
    version:'2',partitionBy:[],
    root:{kind:'window',window,
      child:{kind:'repeat',mode,contiguity:'combinations',
        min:2,max:2,child:{kind:'event',ref:'x'}}},
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:100},
    execution:{maxCandidates:512,maxSemanticEvaluations:0,maxBufferedEvents:512},
  });
}
// Standalone finite mathematical pair enumeration; no production evaluator,
// candidate merge, repeat or temporal helper is called by the reference.
function pairWithin(corpus,a,b,window) {
  const first=Date.parse(a.occurredAt);
  const second=Date.parse(b.occurredAt);
  const lo=Math.min(first,second),hi=Math.max(first,second);
  const span=hi-lo;
  switch(window.type) {
    case 'within':
    case 'sliding': return span<=window.sizeMs;
    case 'session': return span<=window.gapMs;
    case 'count':
      return Math.abs(corpus.indexOf(a)-corpus.indexOf(b))+1<=window.size;
    case 'tumbling':
      return Math.floor((lo-window.offsetMs)/window.sizeMs) ===
        Math.floor((hi-window.offsetMs)/window.sizeMs);
    case 'hopping': {
      for(let start=lo-window.sizeMs+1;start<=lo;start++) {
        if ((start-window.offsetMs)%window.hopMs===0 &&
            start<=lo && hi<start+window.sizeMs) return true;
      }
      return false;
    }
    default:throw new TypeError('unsupported window type');
  }
}
function oracle(events,window) {
  if(events.length<2||events.length>9 ||
    !windows.some(w=>w.type===window?.type)) {
    throw new TypeError('finite nested oracle domain');
  }
  const chronological=[...events].sort((a,b)=>
    Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  const ids=new Set();
  for(let i=0;i<chronological.length;i++) {
    const item=chronological[i];
    if(!['x','noise'].includes(item.clauseId) ||
      !item.sourceEventId || ids.has(item.sourceEventId) ||
      !Number.isFinite(Date.parse(item.occurredAt)) ||
      (i>0 && Date.parse(item.occurredAt)<=
        Date.parse(chronological[i-1].occurredAt))) {
      throw new TypeError('finite nested oracle needs unique ordered evidence');
    }
    ids.add(item.sourceEventId);
  }
  const xs=chronological.filter(e=>e.clauseId==='x');
  const result=[];
  for(let i=0;i<xs.length;i++) {
    for(let j=i+1;j<xs.length;j++) {
      if(pairWithin(chronological,xs[i],xs[j],window)) {
        result.push([xs[i].sourceEventId,xs[j].sourceEventId]);
      }
    }
  }
  return result.sort((a,b)=>a.join('|').localeCompare(b.join('|')));
}
function projection(output) {
  return output.matches.map(candidate=>{
    assert.deepEqual(Object.keys(candidate.bindings).sort(),['x']);
    const ids=candidate.bindings.x.map(e=>e.sourceEventId);
    assert.deepEqual(candidate.events.map(e=>e.sourceEventId),ids,
      'two nested repeat sources must preserve exact ordered provenance');
    assert.equal(ids.length,2,'nested repeat must preserve bound cardinality');
    return ids;
  }).sort((a,b)=>a.join('|').localeCompare(b.join('|')));
}

for(const window of windows) {
  test('window(repeat(x,2..2)) finite differential '+window.type+
    ('offsetMs' in window ? '/offset='+window.offsetMs : ''), async()=>{
    let kept=0,rejected=0;
    for(let seed=1;seed<=100;seed++) {
      const corpus=sample(seed);
      const expected=oracle(corpus,window);
      const xs=corpus.filter(e=>e.clauseId==='x').length;
      const total=xs*(xs-1)/2;
      kept+=expected.length;rejected+=total-expected.length;
      const delivered=[corpus,[...corpus].reverse(),
        [...corpus.slice(2),...corpus.slice(0,2)]];
      for(const mode of ['greedy','lazy']) {
        for(const [round,events] of delivered.entries()) {
          const actual=await evaluatePatternV2({
            definition:config(window,mode),events,
            now:new Date('2026-10-17T00:00:00Z'),
          });
          assert.equal(actual.truncated,false,
            window.type+'/'+seed+'/'+mode+'/'+round);
          assert.deepEqual(actual.pending,[]);
          assert.deepEqual(projection(actual),expected,
            window.type+'/'+seed+'/'+mode+'/'+round);
        }
      }
    }
    assert.ok(kept>0 && rejected>0,
      window.type+' must witness accepted and rejected nested candidates');
  });
}

test('nonzero offsets change actual tumbling and hopping membership',async()=>{
  // Fixed epoch anchors make an offset=0 bucket valid but offset=137 split
  // that exact pair. This rejects an evaluator that silently ignores
  // offsetMs, unlike a self-only independent reference mutation.
  const bucket=Math.floor(origin/600)*600;
  const fixture=[
    {...sample(2)[0],clauseId:'x',sourceEventId:'boundary:a',
      occurredAt:new Date(bucket+100).toISOString()},
    {...sample(2)[1],clauseId:'x',sourceEventId:'boundary:b',
      occurredAt:new Date(bucket+550).toISOString()},
  ];
  for(const kind of ['tumbling','hopping']){
    const atZero=kind==='tumbling'?
      {type:kind,sizeMs:600,offsetMs:0}:
      {type:kind,sizeMs:600,hopMs:300,offsetMs:0};
    const offset={...atZero,offsetMs:137};
    assert.equal(oracle(fixture,atZero).length,1);
    assert.equal(oracle(fixture,offset).length,0);
    for(const mode of ['greedy','lazy']){
      const old=await evaluatePatternV2({
        definition:config(atZero,mode),events:fixture,
      });
      const shifted=await evaluatePatternV2({
        definition:config(offset,mode),events:[...fixture].reverse(),
      });
      assert.equal(old.truncated,false);assert.equal(shifted.truncated,false);
      assert.deepEqual(projection(old),oracle(fixture,atZero));
      assert.deepEqual(projection(shifted),oracle(fixture,offset));
    }
  }
});

test('nested reference rejects unsupported and mutated boundary assumptions',()=>{
  const events=[sample(1)[0],sample(1)[2]];
  const a={...events[0],sourceEventId:'a',clauseId:'x',
    occurredAt:new Date(origin).toISOString()};
  const b={...events[1],sourceEventId:'b',clauseId:'x',
    occurredAt:new Date(origin+400).toISOString()};
  assert.equal(oracle([a,b],{type:'within',sizeMs:400}).length,1);
  assert.equal(oracle([a,b],{type:'within',sizeMs:399}).length,0);
  assert.throws(()=>oracle([a,a],windows[0]),/unique ordered/);
  assert.throws(()=>oracle([a,b],{type:'unknown'}),/domain/);
});
