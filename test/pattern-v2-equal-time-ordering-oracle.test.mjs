import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema, evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

const definition = PatternAstV2DefinitionSchema.parse({
  version:'2',
  root:{kind:'sequence',contiguity:'next',children:[
    {kind:'event',ref:'a'},{kind:'event',ref:'b'},
  ]},
  partitionBy:[],
  selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:100},
  execution:{maxCandidates:128,maxSemanticEvaluations:0,maxBufferedEvents:128},
});

function event(ref,id,time) {
  return {
    clauseId:ref,sourceEventId:id,traceId:'tie:'+ref+':'+id,
    eventName:ref+'.event',occurredAt:time,
    provider:'synthetic',serverId:'tie-oracle',
    subscriptionArguments:{},data:{},
  };
}

function referencePairs(events) {
  const timeline=[...events].sort((a,b)=>
    Date.parse(a.occurredAt)-Date.parse(b.occurredAt) ||
    a.sourceEventId.localeCompare(b.sourceEventId) ||
    a.clauseId.localeCompare(b.clauseId));
  const result=[];
  for(let i=0;i+1<timeline.length;i++){
    if(timeline[i].clauseId==='a' && timeline[i+1].clauseId==='b'){
      result.push([
        timeline[i].clauseId+':'+timeline[i].sourceEventId,
        timeline[i+1].clauseId+':'+timeline[i+1].sourceEventId,
      ]);
    }
  }
  return result;
}
function identities(result){
  return result.matches.map(candidate=>
    candidate.events.map(x=>x.clauseId+':'+x.sourceEventId));
}
function permutation(events){
  return [
    events,
    [...events].reverse(),
    [...events.slice(2),...events.slice(0,2)],
  ];
}
async function assertMatches(events, label){
  const expected=referencePairs(events);
  for(const [round,delivered] of permutation(events).entries()){
    const result=await evaluatePatternV2({definition,events:delivered});
    assert.equal(result.truncated,false,label+'/round='+round);
    assert.deepEqual(result.pending,[],label+'/round='+round);
    assert.deepEqual(identities(result),expected,label+'/round='+round);
  }
  return expected;
}

test('same-instant ordering is explicitly by source ID then clause, independent of ingress',async()=>{
  const when='2026-10-15T12:00:00.000Z';
  const fixture=[
    {...event('b','shared',when),serverId:'tie-host-b'},
    {...event('a','shared',when),serverId:'tie-host-a'},
    event('b','zz',when),
    event('a','aa',when),
  ];
  // sort by ID: a:aa, a:shared, b:shared, b:zz;
  // only one immediate adjacent a -> b is a:shared -> b:shared.
  const result=await assertMatches(fixture,'source-id-clause-ties');
  assert.deepEqual(result,[['a:shared','b:shared']]);
});

test('tie-break oracle covers seeded mixed-time streams and reverse delivery', {
  timeout:60000,
},async()=>{
  let matched=0;
  let sameInstant=0;
  let changesAgainstArrival=0;
  const epoch=Date.UTC(2026,9,15,12);
  for(let seed=1;seed<=96;seed++){
    const len=4+(seed%6);
    const fixture=Array.from({length:len},(_,i)=>{
      const ref=(i+seed)%2===0?'a':'b';
      const id='id-'+String((seed*7+i*11)%101).padStart(3,'0');
      const at=new Date(epoch+Math.floor(i/3)*500).toISOString();
      return event(ref,id,at);
    });
    assert.equal(new Set(fixture.map(x=>x.sourceEventId)).size,fixture.length);
    const expected=await assertMatches(fixture,'seed='+seed);
    matched+=expected.length;
    sameInstant+=new Set(fixture.map(x=>x.occurredAt)).size<fixture.length?1:0;
    const naive=fixture.filter((e,i)=>
      i+1<fixture.length && e.clauseId==='a' && fixture[i+1].clauseId==='b');
    if(naive.length!==expected.length)changesAgainstArrival++;
  }
  assert.ok(matched>0,'seeded streams must include actual next matches');
  assert.ok(sameInstant===96,'each stream exercises equal timestamps');
  assert.ok(changesAgainstArrival>0,
    'at least one seed must distinguish event-time tie sort from arrival order');
});

test('extreme valid ISO dates and explicit equivalent UTC offsets remain deterministic',async()=>{
  const fixture=[
    event('b','year-0001-b','0001-01-01T00:00:00.000Z'),
    event('a','year-0001-a','0001-01-01T00:00:00.000Z'),
    event('b','year-9999-b','9999-12-31T23:59:59.999Z'),
    event('a','year-9999-a','9999-12-31T23:59:59.999Z'),
  ];
  assert.deepEqual(await assertMatches(fixture,'extreme-date'),[
    ['a:year-0001-a','b:year-0001-b'],
    ['a:year-9999-a','b:year-9999-b'],
  ]);
  const sameInstant=[
    event('a','a-1','2026-10-15T14:00:00.000+02:00'),
    event('b','b-1','2026-10-15T12:00:00.000Z'),
  ];
  assert.deepEqual(await assertMatches(sameInstant,'offset-equivalence'),[
    ['a:a-1','b:b-1'],
  ]);
});
