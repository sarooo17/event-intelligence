import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// A successful attestation must include every executable compiled JS file,
// including transitive modules. A symlink is rejected instead of skipped:
// Node follows symlinks during import, and ignoring one would falsely attest
// unchanged code even if its target changed after the build.
export async function attestCompiledRuntime(root) {
  const files = [];
  async function visit(dir, relative = '') {
    const entries = (await readdir(dir, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = relative + entry.name;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error('Compiled runtime attestation rejects symlinks: ' +
          relativePath);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath + '/');
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push({
          path: relativePath,
          sha256: createHash('sha256')
            .update(await readFile(absolutePath))
            .digest('hex'),
        });
      }
    }
  }
  await visit(root);
  if (!files.length) {
    throw new Error('Compiled runtime attestation has no JavaScript files');
  }
  return {
    fileCount: files.length,
    sha256: createHash('sha256')
      .update(JSON.stringify(files))
      .digest('hex'),
  };
}
