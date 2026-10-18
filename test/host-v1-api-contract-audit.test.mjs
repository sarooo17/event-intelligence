import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import * as embeddedPublic from '../scripts/embedded-host-kit.mjs';
const { createEventIntelligence, HOST_CONTRACT_CAPABILITIES } = embeddedPublic;

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const read = file => readFileSync(path.join(root, file), 'utf8');
const deliver = () => ({ runtimeReceiptId: 'unreachable-preflight' });

test('canonical v1 public exports and declarations exist in packed package manifest', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const subpath of ['./embedded', './host', './conformance']) {
    const entry = pkg.exports[subpath];
    assert.ok(entry, 'missing public export ' + subpath);
    for (const role of ['import', 'types']) {
      assert.ok(typeof entry[role] === 'string' && entry[role].startsWith('./'),
        subpath + ' missing ' + role + ' target');
      assert.equal(existsSync(path.join(root, entry[role])), true,
        subpath + ' has nonexistent ' + role + ' target');
    }
  }
  // Probe actual entrypoint bindings; textual substring matches can stay
  // green even if a public re-export or an ambient type is removed.
  for (const surface of ['createEventIntelligence', 'negotiateHostContract']) {
    assert.equal(typeof embeddedPublic[surface], 'function',
      surface + ' must remain an actual public callable export');
  }
  assert.equal(embeddedPublic.HOST_CONTRACT_VERSION, '1');
  assert.ok(embeddedPublic.HOST_CONTRACT_CAPABILITIES.includes('wake.receipts'));
  execFileSync(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '--noEmit', '--strict', '--skipLibCheck',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--target', 'ES2022', 'test/fixtures/host-contract-v1-public-types.mts',
  ], { cwd: root, stdio: 'inherit', timeout: 30000 });
  const runtime = read('scripts/embedded-host-kit.mjs');
  // The advanced low-level path is separate functionality, not a hidden
  // vendor-shaped wrapper around the canonical facade.
  assert.match(runtime, /export async function createEmbeddedRuntimeIntegration/);
  assert.match(runtime, /export async function createEventIntelligence/);
});

test('invalid host boundaries fail closed with stable public EI_HOST codes before createHost()', async () => {
  const cases = [
    {
      name: 'delivery missing', input: { runtime: {} },
      code: 'EI_HOST_DELIVERY_REQUIRED',
    },
    {
      name: 'invalid MCP registry', input: { runtime: { deliver }, mcp: { list: null } },
      code: 'EI_HOST_MCP_REGISTRY_INVALID',
    },
    {
      name: 'owner control absent', input: { runtime: { deliver, resolveContext: () => ({}) } },
      code: 'EI_HOST_CONTROL_REQUIRED',
    },
    {
      name: 'receipt namespace conflict',
      input: { runtime: { deliver, receiptNamespace: 'host', receiptId: () => 'id' } },
      code: 'EI_HOST_RECEIPT_CONFIG_INVALID',
    },
    {
      name: 'unsupported contract version',
      input: { runtime: { deliver }, hostContract: { version: '99', required: [] } },
      code: 'EI_HOST_CONTRACT_VERSION_UNSUPPORTED',
    },
    {
      name: 'unknown capability',
      input: { runtime: { deliver }, hostContract: { version: '1', required: ['not.real'] } },
      code: 'EI_HOST_CAPABILITY_UNKNOWN',
    },
    {
      name: 'unconfigured required registry',
      input: { runtime: { deliver }, hostContract: { version: '1', required: ['mcp.registry'] } },
      code: 'EI_HOST_CAPABILITY_UNAVAILABLE',
    },
    {
      name: 'unconfigured wake receipts',
      input: { runtime: { deliver }, hostContract: { version: '1', required: ['wake.receipts'] } },
      code: 'EI_HOST_CAPABILITY_UNAVAILABLE',
    },
    {
      name: 'unconfigured owner-scoped tools',
      input: { runtime: { deliver }, hostContract: { version: '1', required: ['tooling.owner-scoped'] } },
      code: 'EI_HOST_CAPABILITY_UNAVAILABLE',
    },
    {
      name: 'invalid custom durable storage',
      input: { runtime: { deliver }, store: {},
        hostContract: { version: '1', required: ['storage.durable'] } },
      code: 'EI_HOST_STORAGE_REQUIRED',
    },
    {
      name: 'missing shared-state store',
      input: { runtime: { deliver }, store: {},
        hostContract: { version: '1', required: ['storage.shared'] } },
      code: 'EI_HOST_SHARED_STORE_REQUIRED',
    },
  ];
  assert.ok(HOST_CONTRACT_CAPABILITIES.includes('mcp.registry'));
  assert.ok(HOST_CONTRACT_CAPABILITIES.includes('wake.receipts'));
  for (const entry of cases) {
    let started = 0;
    const input = {
      ...entry.input,
      createHost: async () => {
        started++;
        throw new Error('host unexpectedly started');
      },
    };
    await assert.rejects(createEventIntelligence(input), error =>
      error instanceof TypeError && error.code === entry.code,
      entry.name + ' must reject with ' + entry.code);
    assert.equal(started, 0, entry.name + ' started host with invalid configuration');
  }
});

function rejectVendorDispatch(code) {
  const patterns = [
    /\bto(?:Muffin|OpenAI|Artemis)\s*\(/i,
    /\b(?:runtime|host)(?:\.(?:name|type|runtime|kind))?\s*={2,3}\s*['"`](?:muffin|artemis|openai)['"`]/i,
    /\b['"`](?:muffin|artemis|openai)['"`]\s*={2,3}\s*(?:runtime|host)(?:\.(?:name|type|runtime|kind))?/i,
    /\bswitch\s*\(\s*(?:runtime|host)(?:\.(?:name|type|runtime|kind))?\s*\)/i,
    /\b(?:adapters|dispatch|vendorAdapters)\s*\[\s*(?:runtime|host)(?:\.(?:name|type|runtime|kind))?\s*\]/i,
    /\b(?:authorize|authorizationFallback)\s*:\s*(?:\(|function)\s*/i,
  ];
  for (const pattern of patterns) {
    assert.doesNotMatch(code, pattern, 'found vendor dispatcher or legacy authorization shim');
  }
}

test('runtime name dispatch regression guard handles dotted equality, switch, and adapter index', () => {
  for (const snippet of [
    "if (runtime.name === 'muffin') {}",
    "if (host.type === 'artemis') {}",
    "switch (runtime.type) {}",
    "const adapter = adapters[runtime.name]",
    "toOpenAI(input)",
  ]) {
    assert.throws(() => rejectVendorDispatch(snippet), undefined,
      'guard missed vendor-shaped dispatch: ' + snippet);
  }
  assert.doesNotThrow(() => rejectVendorDispatch(
    "const callback = runtime.deliver; const source = host.mcpStatus();",
  ));
});

test('core contract has no vendor runtime dispatch or authorization shim', () => {
  const paths = [
    'scripts/embedded-host-kit.mjs',
    'scripts/host-integration.mjs',
    'scripts/lib/embedded-host-contract.mjs',
  ];
  for (const file of paths) rejectVendorDispatch(read(file));
});
