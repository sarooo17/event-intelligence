import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import {
  createEventIntelligence,
  HOST_CONTRACT_CAPABILITIES,
} from '../scripts/embedded-host-kit.mjs';

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
  const types = read('scripts/embedded-host-kit.d.mts');
  const runtime = read('scripts/embedded-host-kit.mjs');
  for (const surface of [
    'createEventIntelligence', 'hostContract', 'negotiateHostContract',
  ]) {
    assert.match(types, new RegExp('\\b' + surface + '\\b'),
      surface + ' is not part of the declared public contract');
    assert.match(runtime, new RegExp('\\b' + surface + '\\b'));
  }
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

test('core contract has no vendor runtime dispatch or authorization shim', () => {
  const paths = [
    'scripts/embedded-host-kit.mjs',
    'scripts/host-integration.mjs',
    'scripts/lib/embedded-host-contract.mjs',
  ];
  for (const file of paths) {
    const code = read(file);
    assert.doesNotMatch(code, /\bto(?:Muffin|OpenAI|Artemis)\s*\(/i, file);
    assert.doesNotMatch(code,
      /\b(?:runtime|host)(?:Name|Type)?\s*===?\s*['"`](?:muffin|artemis|openai)['"`]/i,
      file);
    assert.doesNotMatch(code,
      /\b(?:authorize|authorizationFallback)\s*:\s*(?:\(|function)\s*/i,
      file + ' appears to restore legacy authorization fallback');
  }
});
