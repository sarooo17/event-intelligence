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
  assert.equal(report.requiredCount,9);
  assert.equal(report.optionalCount,3);
  assert.equal(report.blocked.includes('embedded-host-independent'),false);
  assert.equal(ledger.criteria.find(x=>x.id==='embedded-host-independent').required,false);
  assert.equal(ledger.criteria.find(x=>x.id==='embedded-host-independent').status,'blocked');
  assert.ok(report.blocked.includes('security-independent-review'));
  assert.ok(report.blocked.includes('pg-retention-audit'));
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


test('criteria cannot attach security evidence to integration issue or vice versa',()=>{
  const altered=clone(ledger);
  altered.criteria.find(x=>x.id==='security-independent-review').issue=42;
  altered.criteria.find(x=>x.id==='embedded-host-independent').issue=45;
  const report=evaluateV1Readiness(altered,'1.0.0');
  assert.equal(report.status,'blocked');
  assert.ok(report.errors.some(x=>x.includes('security-independent-review')));
  assert.ok(report.errors.some(x=>x.includes('embedded-host-independent')));
});

test('audit date must be a real past or present UTC calendar day',()=>{
  for(const invalid of [
    '9999-99-99','2026-02-30','2030-01-01',
    '2026-13-01','2026-00-01','2026-10-18T00:00:00Z',
  ]) {
    const altered=clone(ledger);
    const row=altered.criteria.find(x=>x.id==='embedded-host-independent');
    row.status='verified';
    row.evidence=['https://github.com/sarooo17/event-intelligence/pull/188'];
    row.verification={
      reviewer:'independent-reviewer',
      procedure:'Verify third-party host conformance',
      date:invalid,
    };
    const report=evaluateV1Readiness(altered,'1.0.0');
    assert.equal(report.status,'blocked',invalid);
    assert.ok(report.errors.some(x=>x.includes('audit evidence')),invalid);
  }
});

test('owner-waived independent authoring is optional but cannot bypass v1 P0 release gates',()=>{
  const waived=clone(ledger);
  const row=waived.criteria.find(x=>x.id==='embedded-host-independent');
  assert.equal(row.required,false);
  assert.equal(row.status,'blocked');
  assert.equal(evaluateV1Readiness(waived,'1.0.0').status,'blocked');
  const malicious=clone(ledger);
  malicious.criteria.find(x=>x.id==='embedded-host-independent').required=true;
  assert.ok(evaluateV1Readiness(malicious,'1.0.0').errors.some(x=>x.includes('embedded-host-independent')));
  const bypass=clone(ledger);
  for(const r of bypass.criteria)if(r.required)r.status='verified';
  assert.ok(evaluateV1Readiness(bypass,'1.0.0').errors.length>=9,
    'independent/manual reviewer and specific evidence mandatory for all nine gates');
});
