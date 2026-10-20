import assert from 'node:assert/strict';
import test from 'node:test';
import {validateRoundEvidence} from
  '../scripts/evidence/postgres-os-chaos-evidence.mjs';

function proof(round){
  return {
    round,killedPid:1100+round,signal:'SIGKILL',
    successorPids:[2100+round*2,2101+round*2],
    matchId:'match-'+round,wakeId:'wake-'+round,
    attempts:1,effects:1,deliveryGeneration:1,
    receiptId:'fixture-external:wake-'+round,
  };
}
function corpus(){return {evidence:[proof(0),proof(1)]};}
test('validated raw OS recovery proof requires an ordered, unique complete record for every round',()=>{
  assert.equal(validateRoundEvidence(corpus(),2),true);
  const cases=[
    d=>{d.evidence=[];},
    d=>{d.evidence[1]=d.evidence[0];},
    d=>{d.evidence[0]=null;},
    d=>{d.evidence[1].round=3;},
    d=>{d.evidence[1].signal='SIGTERM';},
    d=>{d.evidence[1].killedPid=0;},
    d=>{d.evidence[1].successorPids=[1,1];},
    d=>{d.evidence[1].successorPids=[1101,2];},
    d=>{d.evidence[1].successorPids=[];},
    d=>{d.evidence[1].attempts=2;},
    d=>{d.evidence[1].effects=0;},
    d=>{d.evidence[1].deliveryGeneration=0;},
    d=>{d.evidence[1].matchId=d.evidence[0].matchId;},
    d=>{d.evidence[1].wakeId=d.evidence[0].wakeId;},
    d=>{d.evidence[1].receiptId='fabricated';},
  ];
  for(const mutate of cases){
    const d=corpus();mutate(d);
    assert.throws(()=>validateRoundEvidence(d,2),undefined,
      'invalid raw proof must never be accepted');
  }
});
