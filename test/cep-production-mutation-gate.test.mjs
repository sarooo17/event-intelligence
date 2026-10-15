import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MUTATION_CORPUS_VERSION,
  runMutationCorpus,
} from '../scripts/evidence/cep-production-mutation-harness.mjs';

test('bounded production evaluator mutations must all be killed by independent invariants', {
  timeout: 60000,
}, async () => {
  const result = await runMutationCorpus();
  assert.equal(result.format, MUTATION_CORPUS_VERSION);
  assert.equal(result.seed, 20261015);
  assert.equal(result.totalMutants, 3);
  assert.equal(result.killedMutants, result.totalMutants);
  assert.deepEqual(result.mutants.map(x => x.mutation), [
    'event_limit_off_by_one',
    'allof_dropped_truncation',
    'negative_forbidden_deadline_exclusive',
  ]);
  for (const mutation of result.mutants) {
    assert.equal(mutation.evaluated, 16);
    assert.equal(mutation.killed, 16);
    assert.match(mutation.fixtureSha256, /^[a-f0-9]{64}$/);
    assert.match(mutation.mutantCompiledSha256, /^[a-f0-9]{64}$/);
    assert.notDeepEqual(mutation.sampleMutant, mutation.expected);
  }
});
