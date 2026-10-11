import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('TypeScript validates typed source predicates through the public declaration surface', () => {
  const tsc = fileURLToPath(
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
  );
  const fixture = fileURLToPath(
    new URL('./fixtures/typed-simple-trigger-contract.mts', import.meta.url),
  );
  const root = fileURLToPath(new URL('../', import.meta.url));
  // The fixture includes multiple intentionally wrong calls guarded by
  // @ts-expect-error. TS fails if they ever become type-accepted.
  const result = spawnSync(process.execPath, [
    tsc,
    '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--target', 'ES2022',
    fixture,
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0,
    'Public typed source contract rejected valid code or accepted an illegal predicate:\n' +
      result.stdout + '\n' + result.stderr);
});
