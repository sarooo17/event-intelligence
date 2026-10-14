import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// A successful attestation must include every executable compiled JS file,
// including transitive modules. A symlink is rejected instead of skipped:
// Node follows symlinks during import, and ignoring one would falsely attest
// unchanged code even if its target changed after the build.
export async function attestCompiledRuntime(root) {
  // lstat(root) alone follows a symlink in an ancestor (e.g. dist -> other).
  // Check every path component, including the final root, before traversal.
  const absoluteRoot = path.resolve(root);
  const pathRoot = path.parse(absoluteRoot).root;
  let inspected = pathRoot;
  const components = absoluteRoot.slice(pathRoot.length)
    .split(path.sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    inspected = path.join(inspected, component);
    const status = await lstat(inspected);
    if (status.isSymbolicLink()) {
      throw new Error('Compiled runtime attestation rejects symlinks: ' +
        (index === components.length - 1 ? '<root>' : '<ancestor>'));
    }
    if (!status.isDirectory()) {
      throw new Error('Compiled runtime attestation requires a directory root');
    }
  }
  // Even the filesystem root itself must be a directory.
  const rootStatus = await lstat(absoluteRoot);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error('Compiled runtime attestation requires a directory root');
  }
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
  await visit(absoluteRoot);
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
