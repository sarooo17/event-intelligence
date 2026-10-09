import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Verify declared exports point to actual files in the npm tarball, not only checkout. */
export function validatePackedExports(manifest, packedFiles) {
  const files = new Set(packedFiles.map((file) =>
    typeof file === 'string' ? file : file?.path
  ));
  const errors = [];
  const exports = manifest?.exports;
  if (!exports || typeof exports !== 'object' ||
      Object.keys(exports).length === 0) {
    return ['package.json must declare explicit exports'];
  }

  const verifyTarget = (key, condition, target) => {
    if (typeof target !== 'string' || !target.startsWith('./')) {
      errors.push(`${key}.${condition} must be a relative ./ file path`);
      return;
    }
    const rawSegments = target.slice(2).split('/');
    // Node rejects package export targets with dot segments *even if* path
    // normalization would resolve them to a file present in the tarball.
    if (rawSegments.some((segment) => segment === '.' || segment === '..')) {
      errors.push(`${key}.${condition}: ${target} contains an invalid dot segment`);
      return;
    }
    const normalized = path.posix.normalize(target.slice(2));
    if (!normalized || normalized === '.' || normalized.startsWith('../') ||
        path.posix.isAbsolute(normalized)) {
      errors.push(`${key}.${condition} escapes package root`);
      return;
    }
    if (!files.has(normalized)) {
      errors.push(`${key}.${condition}: ${target} is absent from packed tarball`);
    }
  };

  for (const [key, mapping] of Object.entries(exports)) {
    if (typeof mapping === 'string') {
      verifyTarget(key, 'default', mapping);
      continue;
    }
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      errors.push(`${key} has an invalid export mapping`);
      continue;
    }
    for (const [condition, target] of Object.entries(mapping)) {
      verifyTarget(key, condition, target);
    }
  }

  const typeOnly = Object.entries(exports)
    .filter(([,mapping]) => mapping && typeof mapping === 'object' && 'types' in mapping)
    .map(([key]) => key);
  assert.ok(typeOnly.length > 0, 'expected at least one typed public export');
  return errors;
}

export function readPackedManifest({
  manifestPath = 'package.json',
  cwd = process.cwd(),
} = {}) {
  const manifest = JSON.parse(readFileSync(path.join(cwd, manifestPath), 'utf8'));
  const raw = execFileSync('npm', [
    'pack', '--dry-run', '--json', '--ignore-scripts',
  ], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries) || !Array.isArray(entries[0]?.files)) {
    throw new Error('npm pack --dry-run did not return a files inventory');
  }
  return {
    manifest,
    packedFiles: entries[0].files,
  };
}

const executedAsScript = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (executedAsScript) {
  const { manifest, packedFiles } = readPackedManifest();
  const errors = validatePackedExports(manifest, packedFiles);
  if (errors.length) {
    for (const error of errors) console.error('PACKED_EXPORT_INVALID: ' + error);
    process.exitCode = 1;
  } else {
    console.log(
      'Packed export parity OK: ' +
      Object.keys(manifest.exports).length + ' public paths verified',
    );
  }
}
