import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-pack-smoke-'));

try {
  const { stdout } = await execFileAsync('npm', ['pack', '--json'], {
    cwd: root,
  });
  const packed = JSON.parse(stdout);
  const filename = packed[0]?.filename;
  assert.ok(filename, 'npm pack did not return a tarball filename');

  await execFileAsync('tar', ['-xzf', path.join(root, filename), '-C', dir]);

  for (const required of [
    'package/bin/mcp-event-intelligence.mjs',
    'package/scripts/mcp-stdio.mjs',
    'package/scripts/mcp-stdio-server.mjs',
    'package/scripts/host-integration.mjs',
    'package/scripts/host-integration.d.mts',
    'package/scripts/lib/local-event-intelligence-runtime.mjs',
    'package/server.json',
  ]) {
    await readFile(path.join(dir, required));
  }

  const manifest = JSON.parse(
    await readFile(path.join(dir, 'package/package.json'), 'utf8'),
  );
  assert.equal(
    manifest.exports?.['./host']?.import,
    './scripts/host-integration.mjs',
  );
  assert.equal(
    manifest.exports?.['./host']?.types,
    './scripts/host-integration.d.mts',
  );

  const help = await execFileAsync(
    process.execPath,
    [path.join(dir, 'package/bin/mcp-event-intelligence.mjs'), '--help'],
  );
  assert.match(help.stdout, /standard MCP stdio control plane/i);
  assert.match(help.stdout, /MCP registry once/i);

  await rm(path.join(root, filename), { force: true });
} finally {
  await rm(dir, { recursive: true, force: true });
}
