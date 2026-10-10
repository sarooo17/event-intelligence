import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../scripts/evidence/postgres-durable-scale.mjs', import.meta.url),
);

function invoke(extraArgs = [], env = {}) {
  const child = spawnSync(process.execPath, [script, ...extraArgs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      POSTGRES_URL: '',
      EI_PG_BENCHMARK_CONFIRM: '',
      ...env,
    },
    timeout: 30_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.stdout, '', 'invalid CLI config cannot emit success');
  assert.notEqual(child.status, 0, 'invalid CLI config must exit nonzero');
  const parsed = JSON.parse(child.stderr);
  assert.equal(parsed.schema, 'event-intelligence.postgres-durable-scale.v1');
  assert.equal(parsed.status, 'failed');
  assert.equal(parsed.phase, 'configuration');
  assert.equal(parsed.failures?.[0]?.phase, 'configuration');
  assert.equal(parsed.failures?.[0]?.code, 'EI_PG_BENCHMARK_CONFIG_INVALID');
  return parsed;
}

test('benchmark refuses missing explicit isolated approval with structured error', () => {
  const result = invoke();
  assert.match(result.failures[0].message, /YES_ISOLATED/);
});

test('benchmark rejects missing DB URL with structured error', () => {
  const result = invoke([], {
    EI_PG_BENCHMARK_CONFIRM: 'YES_ISOLATED',
  });
  assert.match(result.failures[0].message, /POSTGRES_URL/);
});

test('benchmark rejects invalid profiles and malformed sample counts before connecting', () => {
  const base = {
    EI_PG_BENCHMARK_CONFIRM: 'YES_ISOLATED',
    POSTGRES_URL: 'postgresql://localhost:65432/benchmark',
  };
  assert.match(
    invoke(['--profile', 'infinite'], base).failures[0].message,
    /--profile/,
  );
  assert.match(
    invoke(['--profile', 'smoke', '--wakes', '0'], base)
      .failures[0].message,
    /--wakes/,
  );
  assert.match(
    invoke(['--profile', 'smoke', '--concurrency', '999'], base)
      .failures[0].message,
    /--concurrency/,
  );
});
