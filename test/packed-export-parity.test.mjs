import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePackedExports } from '../scripts/check-packed-exports.mjs';

test('every declared import and declaration path must be in npm tarball', () => {
  const manifest = {
    exports: {
      '.': { import: './dist/index.js', types: './dist/index.d.ts' },
      './embedded': { import: './scripts/embedded.mjs', types: './scripts/embedded.d.mts' },
    },
  };
  const files = [
    { path: 'dist/index.js' },
    { path: 'dist/index.d.ts' },
    { path: 'scripts/embedded.mjs' },
    { path: 'scripts/embedded.d.mts' },
  ];
  assert.deepEqual(validatePackedExports(manifest, files), []);
  const missing = validatePackedExports(manifest, files.slice(0, 3));
  assert.equal(missing.length, 1);
  assert.match(missing[0], /embedded\.d\.mts.*absent/);
});

test('pack check rejects absolute, unsafe and malformed export targets', () => {
  const manifest = {
    exports: {
      '.': { types: './types/index.d.ts', import: './../escape.js' },
      './bad': { import: '/secrets.js' },
      './invalid': { import: false },
    },
  };
  const errors = validatePackedExports(manifest, ['types/index.d.ts']);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /invalid dot segment/);
  assert.match(errors[1], /must be a relative/);
  assert.match(errors[2], /must be a relative/);
});

test('pack check rejects dot segments that Node disallows even when files exist', () => {
  const packed = ['dist/index.js', 'index.js', 'dist/entry.js', 'dist/index.d.ts'];
  for (const target of ['./dist/../index.js', './dist/./index.js']) {
    const errors = validatePackedExports({
      exports: {
        '.': { import: target, types: './dist/index.d.ts' },
      },
    }, packed);
    assert.equal(errors.length, 1, target);
    assert.match(errors[0], /invalid dot segment/, target);
  }
});
