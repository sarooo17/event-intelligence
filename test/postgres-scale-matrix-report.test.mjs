import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('matrix aggregation always emits parseable failure artifact when profile is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ei-pg-aggregate-fail-'));
  try {
    const output = join(dir, 'report.json');
    const proc = spawnSync(process.execPath, [
      'scripts/evidence/postgres-scale-matrix-report.mjs',
      output, join(dir, '1k.json'), join(dir, '10k.json'), join(dir, '100k.json'),
    ], { encoding: 'utf8', timeout: 10000 });
    assert.equal(proc.status, 1, proc.stderr);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.productionSloCertified, false);
    assert.equal(result.missingInputPaths.length, 3);
    assert.match(result.code, /^EI_PG_/);
    assert.equal('observed' in result, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('malformed actual input never creates an empty matrix report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ei-pg-aggregate-bad-'));
  try {
    const output = join(dir, 'report.json');
    const files = ['1k', '10k', '100k'].map(n => join(dir, n + '.json'));
    files.forEach(file => writeFileSync(file, '{invalid json'));
    const proc = spawnSync(process.execPath, [
      'scripts/evidence/postgres-scale-matrix-report.mjs', output, ...files,
    ], { encoding: 'utf8', timeout: 10000 });
    assert.equal(proc.status, 1);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.missingInputPaths.length, 0);
    assert.equal(report.code, 'EI_PG_SCALE_EVIDENCE_INVALID');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
