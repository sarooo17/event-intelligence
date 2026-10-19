import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('chaos workflow resolves evidence output at job scope without disallowed runner context', async () => {
  const yaml = await readFile(new URL('../.github/workflows/postgres-os-chaos-manual.yml', import.meta.url), 'utf8');
  const job = yaml.split(/\n  bounded-os-chaos:\s*\n/)[1]?.split(/\n  service-startup-failure-evidence:\s*\n/)[0];
  assert.ok(job, 'primary independent PostgreSQL chaos job must exist');
  const jobEnv = job.split(/\n    env:\s*\n/)[1]?.split(/\n    steps:\s*\n/)[0];
  assert.ok(jobEnv, 'primary job env must be declared');
  assert.doesNotMatch(jobEnv, /\$\{\{\s*runner\./,
    'GitHub rejects runner context inside jobs.<job_id>.env before any steps run');
  assert.match(jobEnv, /^\s+EI_CHAOS_EVIDENCE_OUT: pg-os-chaos-evidence\.json\s*$/m,
    'relative evidence path is rooted in the checked-out workspace');
  assert.match(job, /if:\s*always\(\)/, 'archive evidence on failure');
  assert.match(job, /^\s+pg-os-chaos-evidence\.json\s*$/m,
    'archive the same path written by the harness and failure JSON guard');
});
