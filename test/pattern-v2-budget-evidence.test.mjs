import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  interpretEvaluation,
  runBudgetEvidence,
} from '../scripts/evidence/pattern-v2-budget-evidence.mjs';

const hash = value => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');

test('candidate truncation can return zero matches despite a full-budget match', async () => {
  const report = await runBudgetEvidence();
  const truncated = report.cases.find(item =>
    item.name === 'candidate-budget-zero-match-is-inconclusive');
  const full = report.cases.find(item =>
    item.name === 'candidate-budget-sufficient-returns-real-match');
  assert.ok(truncated && full);
  assert.equal(truncated.output.truncated, true);
  assert.deepEqual(truncated.output.matches, [],
    'candidate exhaustion can look exactly like no-match at a superficial glance');
  assert.equal(truncated.output.interpretation, 'incomplete_budget');
  assert.equal(full.output.truncated, false);
  assert.deepEqual(full.output.matches, [
    ['cep-budget-20261014:b:2', 'cep-budget-20261014:c:3'],
  ]);
  assert.equal(full.output.interpretation, 'matched');
  assert.equal(truncated.sourceHash, full.sourceHash,
    'same exact source corpus isolates candidate-budget change');
  assert.notEqual(truncated.definitionHash, full.definitionHash);
  assert.equal(truncated.definition.execution.maxCandidates, 1);
  assert.equal(full.definition.execution.maxCandidates, 32);
});

test('untruncated no-match and temporal pending are distinct from budget exhaustion', async () => {
  const report = await runBudgetEvidence();
  const noMatch = report.cases.find(item =>
    item.name === 'complete-negative-without-required-c-is-no-match');
  const waiting = report.cases.find(item =>
    item.name === 'temporal-negative-has-pending-window');
  assert.ok(noMatch && waiting);
  assert.deepEqual(noMatch.output.matches, []);
  assert.deepEqual(noMatch.output.pending, []);
  assert.equal(noMatch.output.truncated, false);
  assert.equal(noMatch.output.interpretation, 'complete_no_match');
  assert.deepEqual(waiting.output.matches, []);
  assert.equal(waiting.output.pending.length, 1);
  assert.equal(waiting.output.truncated, false);
  assert.equal(waiting.output.interpretation, 'awaiting_temporal_finality');
  assert.equal(waiting.allowedLatenessMs, 30000);
});

test('semantic evaluation budget is bounded and cannot masquerade as complete', async () => {
  const report = await runBudgetEvidence();
  const semantic = report.cases.find(item =>
    item.name === 'semantic-budget-reports-incomplete-results');
  assert.ok(semantic);
  assert.equal(semantic.definition.execution.maxSemanticEvaluations, 1);
  assert.equal(semantic.output.semanticEvaluations, 1);
  assert.equal(semantic.output.truncated, true);
  assert.equal(semantic.output.interpretation, 'incomplete_budget');
  assert.ok(semantic.output.matches.length <= 1);
});

test('diagnostic interpretation gives incomplete state precedence over empty/matched/pending', () => {
  const sample = { matches: [], pending: [], truncated: false };
  assert.equal(interpretEvaluation(sample), 'complete_no_match');
  assert.equal(interpretEvaluation({ ...sample, truncated: true }),
    'incomplete_budget');
  assert.equal(interpretEvaluation({ ...sample, matches: [{}] }), 'matched');
  assert.equal(interpretEvaluation({ ...sample, pending: [{}] }),
    'awaiting_temporal_finality');
  assert.equal(interpretEvaluation({
    ...sample, matches: [{}], pending: [{}], truncated: true,
  }), 'incomplete_budget');
  // Mutation-sensitivity: if the evaluator ever loses its truncation bit,
  // a zero-match result is incorrectly interpreted as complete.
  assert.notEqual(
    interpretEvaluation({ ...sample, truncated: false }),
    interpretEvaluation({ ...sample, truncated: true }),
  );
});

test('budget evidence is reproducible and contains source + definition digests and environment', async () => {
  const first = await runBudgetEvidence();
  const second = await runBudgetEvidence();
  assert.deepEqual(first, second);
  assert.equal(first.schema, 'event-intelligence.cep-budget-evidence.v1');
  assert.equal(first.seed, 20261014);
  assert.equal(first.environment.nodeVersion, process.version);
  assert.equal(first.environment.platform, process.platform);
  assert.equal(first.environment.arch, process.arch);
  assert.match(first.environment.packageVersion, /^\d+\.\d+\.\d+/);
  assert.equal(first.cases.length, 5);
  for (const entry of first.cases) {
    assert.equal(entry.seed, first.seed);
    assert.match(entry.definitionHash, /^[a-f0-9]{64}$/);
    assert.match(entry.sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(entry.definitionHash, hash(entry.definition));
    assert.ok(entry.sources.length);
    assert.equal(entry.sources.length, new Set(
      entry.sources.map(item => item.sourceEventId),
    ).size);
    for (const source of entry.sources) {
      assert.match(source.occurredAt, /^2026-10-14T/);
      assert.ok(source.clauseId);
      assert.ok(source.sourceEventId);
    }
    assert.equal(entry.fixedNow, '2026-10-14T10:01:10.000Z');
  }
  assert.match(first.caveat, /No multi-worker\/restart\/partition guarantee/);
});

test('standalone conformance CLI emits machine-readable evidence after build', () => {
  const raw = execFileSync(process.execPath, [
    'scripts/evidence/pattern-v2-budget-evidence.mjs',
  ], { encoding: 'utf8' });
  const report = JSON.parse(raw);
  assert.equal(report.schema, 'event-intelligence.cep-budget-evidence.v1');
  assert.deepEqual(report.cases.map(item => item.output.interpretation), [
    'incomplete_budget',
    'matched',
    'complete_no_match',
    'awaiting_temporal_finality',
    'incomplete_budget',
  ]);
});
