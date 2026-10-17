import assert from 'node:assert/strict';
import test from 'node:test';
import { runSyntheticTriageCorpus } from '../scripts/evidence/semantic-triage-corpus.mjs';
import { SYNTHETIC_TRIAGE_CASES } from '../scripts/evidence/semantic-triage-fixtures.mjs';

test('synthetic corpus has independent labels and scripted model scores',()=>{
  assert.equal(SYNTHETIC_TRIAGE_CASES.length,14);
  assert.ok(SYNTHETIC_TRIAGE_CASES.some(x=>x.important && x.probability<0.6));
  assert.ok(SYNTHETIC_TRIAGE_CASES.some(x=>!x.important && x.probability>=0.6));
  assert.ok(SYNTHETIC_TRIAGE_CASES.some(x=>!x.eligible && x.probability>0.9));
});

test('real canonical Pattern AST produces reproducible precision/recall/call cost tradeoff',async()=>{
  const a=await runSyntheticTriageCorpus();
  const b=await runSyntheticTriageCorpus();
  assert.deepEqual(a,b);
  assert.equal(a.schema,'ei.semantic-triage-corpus.v1');
  assert.equal(a.cases,14);
  assert.equal(a.profiles.length,2);
  const strict=a.profiles.find(x=>x.profile==='high-precision');
  const balanced=a.profiles.find(x=>x.profile==='balanced');
  assert.equal(strict.calls,12);
  assert.equal(balanced.calls,12);
  assert.equal(strict.quality.falsePositive,0);
  assert.equal(strict.quality.truePositive,2);
  assert.equal(balanced.quality.truePositive,6);
  assert.equal(balanced.quality.falsePositive,1);
  assert.equal(balanced.quality.falseNegative,1);
  assert.equal(balanced.quality.trueNegative,6);
  assert.ok(strict.quality.precision>balanced.quality.precision);
  assert.ok(balanced.quality.recall>strict.quality.recall);
  assert.ok(strict.estimatedTokensPerNotification>
    balanced.estimatedTokensPerNotification);
  for(const profile of a.profiles){
    assert.equal(profile.records.length,14);
    assert.equal(profile.records.filter(r=>r.semanticEvaluations).length,12);
    assert.ok(profile.records.every(r=>r.semanticEvaluations===0||r.semanticEvaluations===1));
    assert.equal(profile.quality.truePositive+profile.quality.falsePositive+
      profile.quality.trueNegative+profile.quality.falseNegative,14);
  }
});
