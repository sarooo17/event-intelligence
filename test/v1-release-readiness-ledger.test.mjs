import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  evaluateV1Readiness, readV1Readiness,
  V1_REQUIRED_CRITERIA,V1_OPTIONAL_CRITERIA,
} from '../scripts/evidence/v1-release-readiness.mjs';

const ledger=JSON.parse(readFileSync(
  new URL('../docs/releases/v1-readiness.json',import.meta.url)));
const clone=x=>structuredClone(x);

test('current pre-v1 candidate remains explicitly blocked without fake approval',()=>{
  const report=readV1Readiness();
  assert.deepEqual(report.errors,[]);
  assert.equal(report.status,'blocked');
  assert.equal(report.autoPublish,false);
  assert.equal(report.requiredCount,10);
  assert.equal(report.optionalCount,2);
  assert.equal(report.blocked.includes('embedded-host-independent'),true);
  assert.equal(report.blocked.includes('pg-scale-measured'),true);
  assert.equal(report.blocked.includes('package-version-not-1.0.0'),true);
});

test('ledger rejects missing, duplicated and unknown criteria',()=>{
  for(const mutate of [
    l=>l.criteria.pop(),
    l=>l.criteria.push(clone(l.criteria[0])),
    l=>l.criteria.push({id:'made-up',required:true,status:'verified'}),
    l=>l.targetVersion='0.11.0',
    l=>l.policy='auto-publish',
  ]) {
    const altered=clone(ledger);
    mutate(altered);
    assert.notDeepEqual(evaluateV1Readiness(altered,'1.0.0').errors,[]);
    assert.equal(evaluateV1Readiness(altered,'1.0.0').status,'blocked');
  }
});

test('no required flag can be flipped or marked verified without evidence and review',()=>{
  for(const [id,required] of [
    ...V1_REQUIRED_CRITERIA.map(id=>[id,true]),
    ...V1_OPTIONAL_CRITERIA.map(id=>[id,false]),
  ]) {
    const wrong=clone(ledger);
    wrong.criteria.find(x=>x.id===id).required=!required;
    assert.notDeepEqual(evaluateV1Readiness(wrong,'1.0.0').errors,[]);
  }
  const premature=clone(ledger);
  premature.criteria.find(x=>x.id==='embedded-host-independent').status='verified';
  const rejected=evaluateV1Readiness(premature,'1.0.0');
  assert.ok(rejected.errors.some(x=>x.includes('independent/manual audit evidence')));
  assert.equal(rejected.status,'blocked');
});

test('documented verification structure alone never bypasses other blockers',()=>{
  const isolated=clone(ledger);
  const row=isolated.criteria.find(x=>x.id==='embedded-host-independent');
  row.status='verified';
  row.evidence=['https://github.com/sarooo17/event-intelligence/pull/999'];
  row.verification={
    reviewer:'human-operator',
    procedure:'Manual code and external host behavior review',
    date:'2026-10-18',
  };
  const report=evaluateV1Readiness(isolated,'1.0.0');
  assert.deepEqual(report.errors,[]);
  assert.equal(report.status,'blocked');
  assert.ok(report.blocked.includes('pg-scale-measured'));
  assert.equal(report.autoPublish,false);
});
