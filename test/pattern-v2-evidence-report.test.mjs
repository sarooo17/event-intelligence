import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function report() {
  return JSON.parse(execFileSync(
    process.execPath,
    ['scripts/evidence/pattern-v2-conformance.mjs'],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 },
  ));
}

test('v3 conformance report commits to replayable versioned input/environment evidence', () => {
  const first = report();
  const second = report();

  assert.equal(first.schema, 'event-intelligence.pattern-conformance.v3');
  assert.equal(first.package.name, 'mcp-event-intelligence');
  assert.match(first.package.version, /^\d+\.\d+\.\d+/);
  assert.equal(first.patternAstVersion, '2');
  assert.equal(first.environment.node, process.version);
  assert.equal(first.environment.arch, process.arch);
  assert.equal(first.environment.platform, process.platform);
  assert.equal(first.reproducibility.replay, 'npm run conformance:pattern-v2');
  assert.match(first.reproducibility.sourceSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.reproducibility.evaluatedModules.map(x => x.path), [
    'dist/src/patternV2/evaluator.js',
    'dist/src/intelligenceProtocol/patternV2Schemas.js',
    'dist/src/semantic/conditionEngine.js',
  ]);
  for (const { path: modulePath, sha256 } of first.reproducibility.evaluatedModules) {
    assert.match(sha256, /^[0-9a-f]{64}$/);
    const actual = createHash('sha256')
      .update(readFileSync(modulePath))
      .digest('hex');
    assert.equal(sha256, actual,
      'manifest must fingerprint the actual compiled evaluator dependency: ' + modulePath);
  }
  assert.equal(first.failed, 0);
  assert.equal(first.passed, 4);
  assert.ok(first.checks.length === first.passed);

  let total = 0;
  let inconclusive = 0;
  for (let index = 0; index < first.checks.length; index++) {
    const entry = first.checks[index];
    assert.equal(entry.ok, true);
    assert.match(entry.inputSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(entry.inputSha256, second.checks[index].inputSha256);
    assert.deepEqual(entry.budgets, second.checks[index].budgets);
    assert.deepEqual(entry.seedRange, second.checks[index].seedRange);
    assert.equal(entry.runs, entry.outcomes.complete + entry.outcomes.inconclusive);
    assert.ok(Number.isFinite(entry.durationMs));
    total += entry.runs;
    inconclusive += entry.outcomes.inconclusive;
  }

  assert.deepEqual(first.checks[0].seedRange, [1, 50]);
  assert.deepEqual(first.checks[1].outcomes, { complete: 0, inconclusive: 1 });
  assert.equal(inconclusive, 1);
  assert.deepEqual(first.evaluations, {
    complete: total - inconclusive,
    inconclusive,
  });
  assert.deepEqual(first.reproducibility, second.reproducibility);
  assert.doesNotMatch(JSON.stringify(first), /Payment failed again|sourceEventId|traceId|subscriptionArguments/);
});
