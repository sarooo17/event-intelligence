import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PUBLIC_PRIORITY_TRIAGE_CASES,
  PUBLIC_PRIORITY_TRIAGE_SNAPSHOT,
} from '../scripts/evidence/semantic-real-redacted-fixtures.mjs';
import {
  runPublicPriorityTriageCorpus,
} from '../scripts/evidence/semantic-real-redacted-corpus.mjs';

test('real public redacted corpus is pinned, diverse and labeled independent of semantic scores',()=>{
  assert.equal(PUBLIC_PRIORITY_TRIAGE_SNAPSHOT,'2026-10-29');
  assert.equal(PUBLIC_PRIORITY_TRIAGE_CASES.length,40);
  assert.equal(PUBLIC_PRIORITY_TRIAGE_CASES.filter(x=>x.important).length,20);
  assert.equal(PUBLIC_PRIORITY_TRIAGE_CASES.filter(x=>!x.important).length,20);
  const unique=new Set();
  for(const item of PUBLIC_PRIORITY_TRIAGE_CASES){
    assert(/^k8s-\d+$/.test(item.id));
    assert.equal(item.sourceUrl,
      'https://github.com/kubernetes/kubernetes/issues/'+item.issueNumber);
    assert.equal(item.important,
      item.capturedPriority==='priority/critical-urgent');
    assert(['priority/critical-urgent','priority/backlog'].includes(item.capturedPriority));
    assert(item.redactedTitle.length>=10&&item.redactedTitle.length<=200);
    assert(!item.redactedTitle.includes('@'));
    assert(!/https?:\/\/|\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(item.redactedTitle));
    assert(!unique.has(item.id),'Duplicate real source issue');
    unique.add(item.id);
    assert(item.createdAt<='2026-10-29');
  }
});
test('real labels yield reproducible confusion/FN and explicit modeled cost/notification tradeoff',async()=>{
  const one=await runPublicPriorityTriageCorpus();
  const two=await runPublicPriorityTriageCorpus();
  assert.deepEqual(one,two,'fully deterministic no-network dataset');
  assert.equal(one.count,40);
  assert.equal(one.profiles.length,2);
  const [strict,balanced]=one.profiles;
  assert.equal(strict.calls,40);
  assert.equal(balanced.calls,40);
  assert(strict.notifications<=balanced.notifications,
    'higher threshold cannot produce more notifications');
  assert(strict.quality.recall<=balanced.quality.recall,
    'stricter cutoff cannot improve recall on the same scores');
  for(const result of one.profiles){
    const q=result.quality;
    assert.equal(q.truePositive+q.falsePositive+q.trueNegative+q.falseNegative,40);
    assert.equal(q.truePositive+q.falseNegative,20);
    assert.equal(q.trueNegative+q.falsePositive,20);
    assert(result.assumedCostMicros>0);
    assert(result.estimatedInputTokenUpperProxy>0);
    assert(result.assumedCostMicrosPerNotification>0);
    assert.equal(result.records.length,40);
    assert(result.records.every(x=>x.sourceUrl.startsWith(
      'https://github.com/kubernetes/kubernetes/issues/')));
  }
  assert.match(one.model,/NO LLM/);
  assert.match(one.cost,/no actual API billing/);
  assert.match(one.labelAuthority,/NOT human notification relevance/);
});
