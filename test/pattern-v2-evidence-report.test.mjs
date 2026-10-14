import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attestCompiledRuntime } from '../scripts/evidence/compiled-runtime-attestation.mjs';
import test from 'node:test';

function independentlyHashBuild(dir, prefix = '') {
  const files = [];
  for (const item of readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    assert.equal(item.isSymbolicLink(), false,
      'independent runtime manifest verifier must reject symlinks');
    if (item.isDirectory()) {
      files.push(...independentlyHashBuild(
        path.join(dir, item.name), prefix + item.name + '/',
      ));
    } else if (item.isFile() && item.name.endsWith('.js')) {
      files.push({
        path: prefix + item.name,
        sha256: createHash('sha256')
          .update(readFileSync(path.join(dir, item.name)))
          .digest('hex'),
      });
    }
  }
  return files;
}

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
  assert.deepEqual(first.reproducibility.attestationHelper, {
    path: 'scripts/evidence/compiled-runtime-attestation.mjs',
    sha256: createHash('sha256')
      .update(readFileSync('scripts/evidence/compiled-runtime-attestation.mjs'))
      .digest('hex'),
  }, 'report must bind the precise implementation of the imported attestation helper');
  const files = independentlyHashBuild('dist/src');
  const build = first.reproducibility.completeRuntimeBuild;
  assert.equal(build.root, 'dist/src');
  assert.equal(build.fileCount, files.length);
  assert.ok(files.length > 3);
  assert.equal(build.sha256,
    createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    'manifest must include all transitive compiled runtime dependencies');
  assert.equal(first.reproducibility.dependencyLockSha256,
    createHash('sha256').update(readFileSync('package-lock.json')).digest('hex'),
    'manifest must bind external dependency versions via the lockfile');
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


test('conformance command removes stale compiled modules before fresh build', async () => {
  const packageData = JSON.parse(readFileSync('package.json', 'utf8'));
  const script = packageData.scripts['conformance:pattern-v2'];
  const match = /^node -e "([^"]+)" && npm run build && node scripts\/evidence\/pattern-v2-conformance\.mjs$/.exec(script);
  assert.ok(match, 'conformance CLI must clean dist before rebuilding and attest afterward');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-conformance-clean-'));
  try {
    await mkdir(path.join(dir, 'dist', 'src'), { recursive: true });
    await writeFile(path.join(dir, 'dist', 'src', 'stale.js'),
      'export const stale = true;');
    await writeFile(path.join(dir, 'keep.txt'), 'keep');
    execFileSync(process.execPath, ['-e', match[1]], {
      cwd: dir, timeout: 10000,
    });
    assert.equal(existsSync(path.join(dir, 'dist')), false,
      'obsolete dist output must be removed before TypeScript compilation');
    assert.equal(readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'keep',
      'clean operation must not erase unrelated artifacts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('compiled runtime attestation fails closed on symlinked JS or directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-runtime-attestation-'));
  try {
    await writeFile(path.join(dir, 'safe.js'), 'export const ok = true;');
    await mkdir(path.join(dir, 'real'));
    await writeFile(path.join(dir, 'real', 'nested.js'), 'export const n = 1;');
    const before = await attestCompiledRuntime(dir, dir);
    assert.equal(before.fileCount, 2);
    assert.match(before.sha256, /^[0-9a-f]{64}$/);

    await symlink('safe.js', path.join(dir, 'alias.js'));
    await assert.rejects(
      attestCompiledRuntime(dir, dir),
      /attestation rejects symlinks: alias.js/,
    );
    await rm(path.join(dir, 'alias.js'));
    await symlink('real', path.join(dir, 'alias-directory'), 'dir');
    await assert.rejects(
      attestCompiledRuntime(dir, dir),
      /attestation rejects symlinks: alias-directory/,
    );
    // The walker must also reject a symlink passed AS ITS ROOT, rather
    // than only detecting symlinks while enumerating child Dirents.
    await assert.rejects(
      attestCompiledRuntime(path.join(dir, 'alias-directory'), dir),
      /attestation rejects symlinks: <root>/,
    );
    // An intermediate path component such as dist -> another-build must
    // not be followed even when the final dist/src is a real directory.
    await mkdir(path.join(dir, 'alternate-build', 'src'), { recursive: true });
    await writeFile(path.join(dir, 'alternate-build', 'src', 'module.js'),
      'export const alternate = true;');
    await symlink('alternate-build', path.join(dir, 'dist'), 'dir');
    await assert.rejects(
      attestCompiledRuntime(path.join(dir, 'dist', 'src'), dir),
      /attestation rejects symlinks: <ancestor>/,
    );
    // The trusted workspace root itself can be a benign alias (macOS /var),
    // without allowing symlinks *beneath* the trusted root.
    await mkdir(path.join(dir, 'trusted-workspace', 'src'), { recursive: true });
    await writeFile(path.join(dir, 'trusted-workspace', 'src', 'safe.js'),
      'export const safe = true;');
    await symlink('trusted-workspace', path.join(dir, 'workspace-link'), 'dir');
    const aliased = await attestCompiledRuntime(
      path.join(dir, 'workspace-link', 'src'),
      path.join(dir, 'workspace-link'),
    );
    assert.equal(aliased.fileCount, 1);
    await assert.rejects(
      attestCompiledRuntime(path.join(dir, '..'), dir),
      /root must be within trusted root/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
