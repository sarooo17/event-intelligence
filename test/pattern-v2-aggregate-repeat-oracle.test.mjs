import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema, evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

const origin=Date.UTC(2026,9,16,10,0,0);
const thresholds=[-30,0,20,75,140];
function random(seed) {
  let state=(Math.imul(seed,2654435761)^0xb1a2c3d4)>>>0;
  return () => {
    state=(Math.imul(1664525,state)+1013904223)>>>0;
    return state/4294967296;
  };
}
function stream(seed) {
  const rand=random(seed),length=3+(seed%7);
  return Array.from({length},(_,i)=>{
    const kind=i<2?'order':rand()<0.58?'order':'noise';
    const total=Math.floor(rand()*151)-60;
    return {
      clauseId:kind,sourceEventId:'aggregate:'+seed+':'+String(99-i),
      traceId:'aggregate:'+seed+':'+i,
      eventName:kind+'.event',occurredAt:new Date(origin+i*200).toISOString(),
      serverId:'oracle',provider:'synthetic',subscriptionArguments:{},
      data:{total},
    };
  });
}
function definition(threshold,mode) {
  return PatternAstV2DefinitionSchema.parse({
    version:'2',partitionBy:[],
    root:{kind:'aggregate',function:'sum',ref:'order',path:'total',
      op:'gte',value:threshold,
      child:{kind:'repeat',min:2,max:2,mode,contiguity:'combinations',
        child:{kind:'event',ref:'order'}}},
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:100},
    execution:{maxCandidates:512,maxSemanticEvaluations:0,maxBufferedEvents:512},
  });
}
function oracle(events,threshold) {
  if(!Array.isArray(events)||events.length<2||events.length>9||
    !Number.isFinite(threshold)) throw new TypeError('bounded aggregate oracle domain');
  const sorted=[...events].sort((a,b)=>
    Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  const seen=new Set();
  for(let i=0;i<sorted.length;i++){
    const item=sorted[i],time=Date.parse(item.occurredAt);
    if(!item.sourceEventId||seen.has(item.sourceEventId)||
      !Number.isFinite(time)||(i>0 &&
        time<=Date.parse(sorted[i-1].occurredAt))||
      !['order','noise'].includes(item.clauseId)){
      throw new TypeError('oracle requires strict times, refs and unique IDs');
    }
    seen.add(item.sourceEventId);
  }
  const orders=sorted.filter(e=>e.clauseId==='order');
  const result=[];
  for(let i=0;i<orders.length;i++){
    for(let j=i+1;j<orders.length;j++){
      const [a,b]=[orders[i],orders[j]];
      const values=[a.data.total,b.data.total];
      if(values.every(v=>typeof v==='number'&&Number.isFinite(v))&&
        values[0]+values[1]>=threshold){
        result.push([a.sourceEventId,b.sourceEventId]);
      }
    }
  }
  return result.sort((a,b)=>a.join('|').localeCompare(b.join('|')));
}
function output(result) {
  return result.matches.map(c=>{
    const bound=c.bindings.order?.map(e=>e.sourceEventId)??[];
    assert.equal(bound.length,2,'aggregate must preserve both order units');
    assert.deepEqual(c.events.map(e=>e.sourceEventId),bound,
      'aggregate must not add unrelated event provenance');
    assert.ok(c.events.every(e=>e.clauseId==='order'));
    return bound;
  }).sort((a,b)=>a.join('|').localeCompare(b.join('|')));
}

test('sum-gte(repeat(order,2..2)) agrees with finite independent Cartesian oracle', {
  timeout:60000,
},async()=>{
  let admitted=0,rejected=0;
  for(let seed=1;seed<=120;seed++){
    const original=stream(seed);
    const orders=original.filter(x=>x.clauseId==='order').length;
    const possible=orders*(orders-1)/2;
    const arrivals=[
      original,[...original].reverse(),
      [...original.slice(2),...original.slice(0,2)],
    ];
    for(const threshold of thresholds){
      const expected=oracle(original,threshold);
      admitted+=expected.length;rejected+=possible-expected.length;
      for(const mode of ['greedy','lazy']){
        const config=definition(threshold,mode);
        for(const [round,events] of arrivals.entries()){
          const actual=await evaluatePatternV2({
            definition:config,events,
            now:new Date('2026-10-17T00:00:00Z'),
          });
          assert.equal(actual.truncated,false,
            'seed='+seed+'/limit='+threshold+'/'+mode+'/'+round);
          assert.deepEqual(actual.pending,[]);
          assert.deepEqual(output(actual),expected,
            'sum-aggregate differential seed='+seed+
            '/limit='+threshold+'/mode='+mode+'/arrival='+round);
        }
      }
    }
  }
  assert.ok(admitted>0&&rejected>0,
    'generator must witness accepted and rejected sum pairs');
});

test('aggregate rejects numeric-string coercion and oracle domain mutations',async()=>{
  const a={...stream(1)[0],clauseId:'order',
    data:{total:7},occurredAt:new Date(origin).toISOString()};
  const b={...stream(1)[1],clauseId:'order',
    data:{total:13},occurredAt:new Date(origin+200).toISOString()};
  assert.equal(oracle([a,b],20).length,1,
    'sum equality must satisfy gte');
  assert.equal(oracle([a,b],21).length,0,
    'sum just below threshold must not satisfy gte');
  const numericString={...b,data:{total:'13'}};
  const expected=oracle([a,numericString],20);
  assert.deepEqual(expected,[],
    'numeric-string field must not silently coerce');
  for(const order of [[a,numericString],[numericString,a]]){
    const actual=await evaluatePatternV2({
      definition:definition(20,'greedy'),events:order,
    });
    assert.equal(actual.truncated,false);
    assert.deepEqual(actual.pending,[]);
    assert.deepEqual(output(actual),expected,
      'production evaluator must not coerce numeric strings');
  }
  // Independent domain witnesses: each violates exactly one condition.
  assert.throws(()=>oracle([a,{...b,sourceEventId:a.sourceEventId}],20),
    /strict times, refs and unique IDs/,
    'duplicate IDs must fail despite strictly increasing timestamps');
  assert.throws(()=>oracle([a,{...b,occurredAt:a.occurredAt}],20),
    /strict times, refs and unique IDs/,
    'equal instants must fail despite distinct IDs');
  assert.throws(()=>oracle([a,b],Infinity),/domain/);
});
