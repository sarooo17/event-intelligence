import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('source count beyond trigger population is rejected before a database connection', () => {
  const result = spawnSync(process.execPath, [
    'scripts/evidence/postgres-mcp-ingest-wake.mjs',
    '--triggers', '8', '--events', '8', '--sources', '32',
  ], {
    encoding: 'utf8', timeout: 10000,
    env: {
      ...process.env,
      EI_PG_PIPELINE_CONFIRM: 'YES_ISOLATED',
      POSTGRES_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
    },
  });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stdout, '');
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.failures.length, 1);
  assert.equal(failure.failures[0].phase, 'configuration');
  assert.equal(failure.failures[0].code, 'EI_PG_PIPELINE_CONFIG_INVALID');
  assert.match(failure.failures[0].message, /sources.*triggers/);
  assert.ok(!result.stderr.includes('unused:unused'));
});
