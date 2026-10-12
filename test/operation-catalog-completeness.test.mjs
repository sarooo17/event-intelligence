import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as z from 'zod/v4';

import {
  OPERATION_MANIFEST,
  OPERATION_MANIFEST_VERSION,
  operationNamesForSurface,
} from '../scripts/lib/operation-manifest.mjs';
import {
  MCP_OPERATION_SCHEMAS,
} from '../scripts/lib/mcp-operation-schemas.mjs';
import {
  EMBEDDED_INPUT_VALIDATORS,
} from '../scripts/lib/embedded-operation-schemas.mjs';
import {
  OPERATION_OUTPUT_CONTRACTS,
  OUTPUT_CONTRACT_EXCEPTIONS,
  outputJsonSchema,
  outputValidator,
} from '../scripts/lib/operation-output-contracts.mjs';
import {
  EMBEDDED_OPERATION_REGISTRY,
  createEventIntelligenceAgentTools,
} from '../scripts/embedded-host-kit.mjs';

const keys = Object.keys(OPERATION_MANIFEST);
const mutationKeys = ['create', 'pause', 'resume', 'delete', 'update'];
const surfaces = ['stdio', 'embedded'];

test('versioned 14-operation inventory has exactly one declared input/output authority per model surface', () => {
  assert.equal(OPERATION_MANIFEST_VERSION, '1');
  assert.equal(keys.length, 14);
  assert.deepEqual(Object.keys(MCP_OPERATION_SCHEMAS).sort(), [...keys].sort());
  assert.deepEqual(Object.keys(OPERATION_OUTPUT_CONTRACTS).sort(), [...keys].sort());
  assert.deepEqual(
    Object.keys(EMBEDDED_INPUT_VALIDATORS).sort(),
    keys.filter(k => OPERATION_MANIFEST[k].surfaces.embedded).sort(),
  );
  assert.deepEqual(Object.keys(EMBEDDED_OPERATION_REGISTRY).sort(),
    Object.keys(EMBEDDED_INPUT_VALIDATORS).sort());
  assert.deepEqual(Object.keys(OUTPUT_CONTRACT_EXCEPTIONS).sort(), [...surfaces].sort());
  assert.deepEqual(Object.keys(OUTPUT_CONTRACT_EXCEPTIONS.embedded), ['inspect']);
  assert.deepEqual(Object.keys(OUTPUT_CONTRACT_EXCEPTIONS.stdio), []);

  const names = new Set(), capabilities = new Set();
  for (const [key, op] of Object.entries(OPERATION_MANIFEST)) {
    assert.equal(names.has(op.name), false, key + ' duplicate wire name');
    assert.equal(capabilities.has(op.capability.id), false, key + ' duplicate capability');
    names.add(op.name); capabilities.add(op.capability.id);
    assert.equal(typeof op.scope, 'string');
    assert.ok(op.scope.length > 0);
    assert.equal(typeof op.capability.resource, 'string');
    assert.ok(op.capability.resource.length > 0);
    assert.equal(
      mutationKeys.includes(key),
      op.capability.effect === 'durable-state',
      key + ' effect metadata drift',
    );
    assert.equal(op.capability.hostControl,
      mutationKeys.includes(key) ? 'required' : 'none', key);
    assert.equal(op.capability.durability,
      mutationKeys.includes(key) ? 'durable' : 'ephemeral', key);

    for (const surface of surfaces) {
      if (!op.surfaces[surface]) {
        assert.equal(OPERATION_OUTPUT_CONTRACTS[key][surface], undefined,
          key + ' must not imply an undiscoverable result surface');
        assert.equal(OUTPUT_CONTRACT_EXCEPTIONS[surface][key], undefined);
        continue;
      }
      const input = surface === 'stdio'
        ? MCP_OPERATION_SCHEMAS[key] : EMBEDDED_INPUT_VALIDATORS[key];
      assert.equal(typeof input?.safeParse, 'function', surface + '.' + key);
      assert.equal(z.toJSONSchema(input, { io: 'input' }).type, 'object');
      const exception = OUTPUT_CONTRACT_EXCEPTIONS[surface][key];
      const modeled = OPERATION_OUTPUT_CONTRACTS[key][surface];
      assert.equal(Boolean(modeled), !exception,
        surface + '.' + key + ' must have output validator OR reviewed exception');
      if (exception) {
        assert.ok(exception.length > 20, 'missing documented reason for '+key);
        assert.throws(() => outputValidator(surface, key), /Unmodeled EI output projection/);
      } else {
        assert.equal(outputValidator(surface, key), modeled);
        assert.equal(outputJsonSchema(surface, key).type, 'object', surface + '.' + key);
      }
    }
  }
});

test('actual embedded agent tool catalog matches the canonical operation manifest and omission ledger', () => {
  const embedded = createEventIntelligenceAgentTools({
    host: {},
    resolveContext: () => ({
      actor: {type:'agent',principal_id:'agent-1'},
      owner: {type:'user',principal_id:'owner-1'},
    }),
    control: () => ({action:'return',result:{ok:false,error:{code:'DENIED'}}}),
  });
  assert.deepEqual(
    embedded.map(tool => tool.name).sort(),
    operationNamesForSurface('embedded').sort(),
  );
  for (const tool of embedded) {
    const [key, operation] = Object.entries(OPERATION_MANIFEST)
      .find(([,meta]) => meta.name === tool.name) ?? [];
    assert.ok(key, tool.name + ' has no canonical operation');
    assert.equal(tool.capability, operation.capability);
    assert.deepEqual(tool.inputSchema,
      z.toJSONSchema(EMBEDDED_INPUT_VALIDATORS[key], {io:'input'}));
    if (OUTPUT_CONTRACT_EXCEPTIONS.embedded[key]) {
      assert.equal(tool.outputSchema, undefined);
    } else {
      assert.deepEqual(tool.outputSchema, outputJsonSchema('embedded', key));
    }
    // Model-facing schemas must not accept identity or approval overrides.
    for (const forbidden of ['owner', 'actor', 'tenant_id', 'confirmationId']) {
      assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, forbidden),
        false, key + ' leaked host-managed authority into model schema');
    }
  }
});

test('read-only exposure removes all durable capabilities; schema inventory documents non-model endpoints', () => {
  for (const surface of surfaces) {
    const readNames = operationNamesForSurface(surface, {allowMutations:false});
    assert.deepEqual(readNames.sort(),
      Object.entries(OPERATION_MANIFEST)
        .filter(([,op]) => op.surfaces[surface] && op.capability.effect === 'none')
        .map(([,op])=>op.name).sort());
    assert.equal(readNames.some(name =>
      mutationKeys.some(key => OPERATION_MANIFEST[key].name === name)), false);
  }

  for (const key of mutationKeys) {
    const mcp = z.toJSONSchema(MCP_OPERATION_SCHEMAS[key], {io:'input'});
    assert.ok(mcp.required.includes('confirmationId'), key);
    assert.equal(Object.hasOwn(mcp.properties, 'owner'), false, key);
    assert.equal(Object.hasOwn(mcp.properties, 'actor'), false, key);
  }
  const docs = readFileSync(new URL('../docs/OPERATION-CATALOG-AUDIT.md', import.meta.url),'utf8');
  for (const key of keys) {
    assert.ok(docs.includes('`' + OPERATION_MANIFEST[key].name + '`'), key);
  }
  assert.match(docs,/embedded\.trigger_inspect/);
  assert.match(docs,/HTTP reference service/);
  assert.match(docs,/doctor/);
  assert.match(docs,/not a model-facing operation/i);
});
