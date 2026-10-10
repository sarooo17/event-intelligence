import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPERATION_MANIFEST,
  OPERATION_MANIFEST_VERSION,
  operationNamesForSurface,
} from '../scripts/lib/operation-manifest.mjs';
import {
  EMBEDDED_OPERATION_REGISTRY,
  EVENT_INTELLIGENCE_CAPABILITIES,
} from '../scripts/embedded-host-kit.mjs';

test('shared EI operation contract has unique names/IDs and immutable metadata', () => {
  assert.equal(OPERATION_MANIFEST_VERSION, '1');
  const definitions = Object.values(OPERATION_MANIFEST);
  assert.equal(definitions.length, 14);
  assert.equal(new Set(definitions.map((entry) => entry.name)).size, definitions.length);
  assert.equal(new Set(definitions.map((entry) => entry.capability.id)).size, definitions.length);
  for (const operation of definitions) {
    assert.equal(Object.isFrozen(operation), true);
    assert.equal(Object.isFrozen(operation.capability), true);
    assert.equal(Object.isFrozen(operation.surfaces), true);
    assert.equal(operation.surfaces.stdio, true);
    assert.equal(
      operation.capability.effect === 'durable-state',
      operation.capability.hostControl === 'required',
    );
    assert.equal(
      operation.capability.effect === 'durable-state',
      operation.capability.durability === 'durable',
    );
  }
});

test('embedded descriptors consume the canonical name and authority metadata', () => {
  const keys = [
    'sources', 'create', 'list', 'inspect',
    'pause', 'resume', 'delete', 'update',
  ];
  assert.deepEqual(
    operationNamesForSurface('embedded').sort(),
    Object.values(EMBEDDED_OPERATION_REGISTRY)
      .map((descriptor) => descriptor.name).sort(),
  );
  for (const key of keys) {
    const desc = EMBEDDED_OPERATION_REGISTRY[key];
    assert.equal(desc.name, OPERATION_MANIFEST[key].name);
    assert.equal(desc.capability, OPERATION_MANIFEST[key].capability);
    assert.equal(Object.isFrozen(desc.inputSchema), true);
  }
  for (const entry of Object.values(EVENT_INTELLIGENCE_CAPABILITIES)) {
    assert.ok(keys.some((key) =>
      OPERATION_MANIFEST[key].capability === entry
    ));
  }
});

test('stdio read-only discovery excludes every declared durable capability', () => {
  const read = operationNamesForSurface('stdio', { allowMutations: false });
  const all = operationNamesForSurface('stdio');
  assert.equal(read.length, 9);
  assert.equal(all.length, 14);
  for (const [key, entry] of Object.entries(OPERATION_MANIFEST)) {
    assert.equal(read.includes(entry.name), entry.capability.effect === 'none', key);
    assert.equal(all.includes(entry.name), true, key);
  }
  assert.throws(() => operationNamesForSurface('other'), /Unknown EI tool surface/);
});
