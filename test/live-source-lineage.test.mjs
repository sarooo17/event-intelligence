import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyLiveFiredSourceLineage} from
  '../scripts/validation/verify-live-source-lineage.mjs';

const sourceEventId='source-oracle-event-test';
const sourceEventTimestamp='2026-11-01T13:55:00.000Z';
const fired=()=>({status:'fired',matchId:'match-f',
  firedWakeId:'wake-actual',sourceEvents:[{
    sourceEventId,occurredAt:sourceEventTimestamp,
  }]});
const empty=()=>({status:'partial',firedWakeId:null,sourceEvents:[]});
const verify=matches=>verifyLiveFiredSourceLineage({
  matches,sourceEventId,sourceEventTimestamp,
});
test('E48-A real Railway Pattern v2 fired match accepts one empty residual candidate buffer',()=>{
  const result=verify([fired(),empty()]);
  assert.equal(result.actualFiredMatches,1);
  assert.equal(result.additionalEmptyCandidateBuffers,1);
  assert.equal(result.record.firedWakeId,'wake-actual');
  assert.equal(verify([empty(),fired()]).actualFiredMatches,1);
  assert.equal(verify([fired()]).additionalEmptyCandidateBuffers,0);
});
test('E48-A source replay / wrong tenant / timestamp / extra effects fail closed',()=>{
  const bad=[
    [],
    [empty()],
    [fired(),fired()],
    [fired(),{...empty(),sourceEvents:[{sourceEventId:'foreign'}]}],
    [{...fired(),sourceEvents:[]}],
    [{...fired(),sourceEvents:[{sourceEventId:'other',occurredAt:sourceEventTimestamp}]}],
    [{...fired(),sourceEvents:[{sourceEventId,occurredAt:'2026-11-01T13:55:01.000Z'}]}],
    [{...fired(),firedWakeId:null}],
    [fired(),{...empty(),firedWakeId:'unexpected'}],
    [fired(),{...empty(),status:'matched'}],
    [fired(),{...empty(),sourceEvents:null}],
    Array.from({length:17},(_,i)=>i===0?fired():empty()),
  ];
  for(const matches of bad)assert.throws(()=>verify(matches),/PG_/);
});
