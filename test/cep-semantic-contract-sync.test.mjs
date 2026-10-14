import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const schema = readFileSync(
  'src/intelligenceProtocol/patternV2Schemas.ts', 'utf8');
const contract = readFileSync(
  'docs/CEP-SEMANTIC-CONTRACT-V2.md', 'utf8');

test('semantic contract covers every canonical Pattern AST v2 kind exactly once', () => {
  const start = schema.indexOf('export const PatternNodeV2Schema');
  const end = schema.indexOf('export type PatternNodeV2', start);
  assert.ok(start !== -1 && end > start, 'must locate the canonical AST schema');
  const schemaBlock = schema.slice(start, end);
  const actual = [...new Set(
    [...schemaBlock.matchAll(/kind:\s*z\.literal\('([^']+)'\)/g)]
      .map(match => match[1]),
  )].sort();
  assert.equal(actual.length, 22,
    'schema kind-count drift requires an explicit conformance review');
  const section = contract.split('## Node contracts')[1]
    ?.split('## Cross-cutting execution contracts')[0];
  assert.ok(section, 'public contract must contain node mapping section');
  const documented = [...section.matchAll(/^\| `([^\`]+)` \|/gm)]
    .map(match => match[1]);
  assert.equal(documented.length, new Set(documented).size,
    'duplicate operator rows would conceal missing coverage');
  assert.deepEqual(documented.sort(), actual,
    'a new/removed AST node must update its public semantic and test category row');
});

test('every operator row declares evidence level and remaining gap', () => {
  const section = contract.split('## Node contracts')[1]
    ?.split('## Cross-cutting execution contracts')[0] ?? '';
  const rows = section.split('\n')
    .filter(line => /^\| `[^\`]+` \|/.test(line));
  assert.equal(rows.length, 22);
  for (const row of rows) {
    assert.match(row, /\| (?:Differential subset|Behavior test|Gap): /,
      'each operator needs an honest proof category: ' + row);
    assert.match(row, /\| [^|]+\|$/,
      'each operator must disclose a specific outstanding gap: ' + row);
    assert.match(row, /test\//,
      'each operator must point to at least one concrete test: ' + row);
  }
});

test('cross-cutting contracts disclose time, partition, budget and host selection boundaries', () => {
  for (const phrase of [
    'allowedLatenessMs', 'maxCandidates', 'maxSemanticEvaluations',
    'truncated:true', 'partitionBy', 'selection.afterMatch',
    'CompositeTriggerEngine', 'onUnavailable:reject',
  ]) {
    assert.ok(contract.includes(phrase),
      'missing mandatory semantic boundary: ' + phrase);
  }
  for (const window of ['within', 'sliding', 'tumbling', 'hopping', 'session', 'count']) {
    assert.ok(contract.includes('`' + window + '`'),
      'missing canonical window variant ' + window);
  }
  assert.match(contract, /not a\s+(?:global )?exactly-once guarantee/);
});
