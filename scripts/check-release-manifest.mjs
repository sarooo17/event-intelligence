import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * Pure release identity validation; checks candidate repo metadata only.
 * Never contacts npm, modifies consumers, or triggers a package publication.
 */
export function validateReleaseManifest(pkg, lock, server) {
  const errors = [];
  const root = lock?.packages?.[''];
  if (!pkg || typeof pkg !== 'object' ||
      typeof pkg.name !== 'string' || !pkg.name.trim() ||
      typeof pkg.version !== 'string' || !pkg.version.trim()) {
    errors.push('package.json requires nonempty name and version');
    return errors;
  }
  const expected = pkg.version;
  for (const [label, got] of [
    ['package-lock.json root', lock?.version],
    ['package-lock.json packages[""]', root?.version],
    ['server.json', server?.version],
  ]) {
    if (got !== expected) errors.push(`${label}: version mismatch`);
  }
  for (const [label, got] of [
    ['package-lock.json root', lock?.name],
    ['package-lock.json packages[""]', root?.name],
  ]) {
    if (got !== pkg.name) errors.push(`${label}: name mismatch`);
  }
  if (!pkg.mcpName || server?.name !== pkg.mcpName) {
    errors.push('server.json: MCP registry name does not equal package mcpName');
  }
  const packages = server?.packages;
  if (!Array.isArray(packages) || packages.length === 0) {
    errors.push('server.json: no published package metadata');
  } else {
    const npmPackages = packages.filter(item => item?.registryType === 'npm');
    if (!npmPackages.length) {
      errors.push('server.json: missing npm package entry');
    }
    for (const entry of npmPackages) {
      if (entry.identifier !== pkg.name) {
        errors.push('server.json: npm package identifier mismatch');
      }
      if (entry.version !== expected) {
        errors.push('server.json: npm package version mismatch');
      }
    }
  }
  return errors;
}

export function checkReleaseManifest(cwd = process.cwd()) {
  const read = file => JSON.parse(
    readFileSync(path.join(cwd, file), 'utf8'),
  );
  return validateReleaseManifest(
    read('package.json'), read('package-lock.json'), read('server.json'),
  );
}

if (process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const errors = checkReleaseManifest();
  if (errors.length) {
    for (const msg of errors) {
      console.error('EI_RELEASE_MANIFEST_MISMATCH: ' + msg);
    }
    process.exitCode = 1;
  } else {
    console.log('EI release identity is consistent across package, lockfile and MCP registry');
  }
}
