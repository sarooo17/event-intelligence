import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema, evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

function event(id, when) {
  return {
    clauseId:'mail',sourceEventId:id,traceId:'calendar-contract:'+id,
    eventName:'mail.received',occurredAt:when,provider:'synthetic',
    serverId:'calendar-host',subscriptionArguments:{},data:{},
  };
}
function definition(config) {
  return PatternAstV2DefinitionSchema.parse({
    version:'2',
    root:{
      kind:'calendar',child:{kind:'event',ref:'mail'},
      ref:'mail',timezone:'Europe/Rome',
      before:'20:00',after:'12:00',...config,
    },
    partitionBy:[],
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:100},
    execution:{maxCandidates:64,maxSemanticEvaluations:0,maxBufferedEvents:64},
  });
}
async function matched(config, occurrences) {
  const results=[];
  for(const delivery of [occurrences,[...occurrences].reverse()]){
    const result=await evaluatePatternV2({
      definition:definition(config),events:delivery,
    });
    assert.equal(result.truncated,false);
    assert.deepEqual(result.pending,[]);
    results.push(result.matches.map(match=>
      match.events.map(e=>e.sourceEventId)).flat());
  }
  assert.deepEqual(results[0],results[1],
    'calendar classification must be independent of arrival order');
  return results[0];
}
const friday=event('friday','2026-09-18T17:30:00.000Z'); // 19:30 Rome
const thursday=event('thursday','2026-09-17T17:30:00.000Z'); // 19:30 Rome
const nextFriday=event('next-friday','2026-09-25T17:30:00.000Z'); // 19:30 Rome
const tooLate=event('late-friday','2026-09-18T18:30:00.000Z'); // 20:30 Rome

test('calendar weekday constraint rejects a matching local clock on a different weekday',async()=>{
  const output=await matched({weekdays:[5]},[
    friday,thursday,nextFriday,tooLate,
  ]);
  assert.deepEqual(output,['friday','next-friday']);
});

test('calendar exact date constraint rejects same weekday and local clock next week',async()=>{
  const output=await matched({dates:['2026-09-18']},[
    friday,thursday,nextFriday,tooLate,
  ]);
  assert.deepEqual(output,['friday']);
});

test('combined calendar date and weekday constraints retain their intersection',async()=>{
  const positive=await matched({
    dates:['2026-09-18'],weekdays:[5],
  },[friday,thursday,nextFriday,tooLate]);
  assert.deepEqual(positive,['friday']);
  const impossible=await matched({
    dates:['2026-09-18'],weekdays:[4],
  },[friday,thursday,nextFriday,tooLate]);
  assert.deepEqual(impossible,[]);
});
