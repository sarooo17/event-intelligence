import assert from 'node:assert/strict';
import test from 'node:test';
import * as z from 'zod/v4';
import { OPERATION_MANIFEST } from '../scripts/lib/operation-manifest.mjs';
import {
  MCP_OPERATION_SCHEMAS,
  mcpInputSchemaFor,
} from '../scripts/lib/mcp-operation-schemas.mjs';

test('MCP operation input registry covers every canonical operation exactly once', () => {
  const a = Object.keys(OPERATION_MANIFEST).sort();
  const b = Object.keys(MCP_OPERATION_SCHEMAS).sort();
  assert.deepEqual(a, b);
  assert.equal(a.length, 14);
  for (const key of a) {
    assert.equal(mcpInputSchemaFor(key), MCP_OPERATION_SCHEMAS[key]);
    assert.equal(typeof MCP_OPERATION_SCHEMAS[key].safeParse, 'function');
    const wire = z.toJSONSchema(MCP_OPERATION_SCHEMAS[key]);
    assert.equal(wire.type, 'object', key);
  }
  assert.throws(() => mcpInputSchemaFor('not-an-operation'), /Unknown EI MCP operation/);
  assert.throws(() => mcpInputSchemaFor('__proto__'), /Unknown EI MCP operation/);
});

test('MCP owner-scoped read and approval-bearing mutation contracts remain strict', () => {
  const list = MCP_OPERATION_SCHEMAS.list;
  assert.equal(list.safeParse({}).success, true);
  assert.equal(list.safeParse({ ownerOnly: false }).success, false);
  const inspect = MCP_OPERATION_SCHEMAS.inspect;
  assert.equal(inspect.safeParse({ triggerId: 'owned' }).success, true);
  assert.equal(inspect.safeParse({}).success, false);
  const wake = MCP_OPERATION_SCHEMAS.wakeHydrate;
  assert.equal(wake.safeParse({ wakeId: 'wake1' }).success, true);
  assert.equal(wake.safeParse({}).success, false);

  for (const key of ['create', 'pause', 'resume', 'delete', 'update']) {
    const wire = z.toJSONSchema(mcpInputSchemaFor(key));
    assert.ok(wire.required.includes('confirmationId'), key);
    assert.equal(wire.properties.confirmationId.type, 'string');
  }
  for (const key of ['pause', 'resume', 'delete']) {
    assert.equal(MCP_OPERATION_SCHEMAS[key], MCP_OPERATION_SCHEMAS.pause);
  }
});
