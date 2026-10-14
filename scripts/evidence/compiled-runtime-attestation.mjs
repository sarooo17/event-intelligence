import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

// A successful attestation must include every executable compiled JS file,
// including transitive modules. A symlink is rejected instead of skipped:
// Node follows symlinks during import, and ignoring one would falsely attest
// unchanged code even if its target changed after the build.
export async function attestCompiledRuntime(root, trustedRoot) {
  if (typeof trustedRoot !== 'string' || !trustedRoot) {
    throw new Error('Compiled runtime attestation requires a trusted root');
  }
  // Only descendants of the explicitly host-trusted repository/build root
  // belong to our trust boundary. OS ancestors such as macOS /var -> /private/var
  // must not cause a false failure, but dist/ and its descendants must be checked.
  const absoluteRoot = path.resolve(root);
  const absoluteTrusted = path.resolve(trustedRoot);
  const relativeRoot = path.relative(absoluteTrusted, absoluteRoot);
  if (relativeRoot === '..' || relativeRoot.startsWith('..' + path.sep) ||
      path.isAbsolute(relativeRoot)) {
    throw new Error('Compiled runtime attestation root must be within trusted root');
  }
  const trustedStatus = await stat(absoluteTrusted);
  if (!trustedStatus.isDirectory()) {
    throw new Error('Compiled runtime attestation requires a directory trusted root');
  }
  let inspected = absoluteTrusted;
  const components = relativeRoot.split(path.sep).filter(Boolean);
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
