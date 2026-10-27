import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindEmbeddedRuntimeIntegration,
  createPortableToolAdapter,
} from '../scripts/embedded-host-kit.mjs';

// Not third-party adoption proof: this is an EI-maintained host-shape probe.
const metadata = Object.freeze({
  id: 'event-intelligence.trigger.inspect',
  operation: 'read', resource: 'trigger', effect: 'none',
  durability: 'durable', hostControl: 'none',
});
const inputSchema = Object.freeze({
  type: 'object',
  properties: { triggerId: { type: 'string' } },
  required: ['triggerId'],
  additionalProperties: false,
});
const outputSchema = Object.freeze({ type: 'object' });

function portable(execute) {
  return {
    name: 'trigger_inspect', description: 'Inspect a trigger',
    inputSchema, outputSchema, capability: metadata, execute,
  };
}

test('bridge rejects missing factories and invalid tools without registering anything', () => {
  for (const options of [undefined, {}, { makeTool: null }, { makeTool: 1 }]) {
    assert.throws(() => createPortableToolAdapter(options), /makeTool/);
  }
  const adapt = createPortableToolAdapter({
    makeTool() { throw Error('should never execute for invalid tool'); },
  });
  for (const bad of [null, undefined, {}, { name: 'no' }, { ...portable(async () => ({})), execute: 2 }]) {
    assert.throws(() => adapt(bad), /valid portable tool/);
  }
});

test('two incompatible native host ABIs receive the same original schema and capability', async () => {
  const outcome = Object.freeze({
    ok: true,
    data: { triggerId: 't1' },
    result: { summary: 'one trigger', reference: { id: 'ref:1' } },
  });
  const tool = portable(async (args, context) => {
    assert.deepEqual(args, { triggerId: 't1' });
    assert.deepEqual(context, { scopeId: 'tenant-a' });
    return outcome;
  });
  let rpcDefinition;
  let agentDefinition;
  const rpcAdapter = createPortableToolAdapter({
    makeTool(definition) {
      rpcDefinition = definition;
      return {
        method: definition.name,
        call: (params, identity) => definition.execute(params, identity),
      };
    },
  });
  const agentAdapter = createPortableToolAdapter({
    makeTool(definition) {
      agentDefinition = definition;
      return {
        function: { name: definition.name, parameters: definition.inputSchema },
        run: (params, identity) => definition.execute(params, identity),
      };
    },
  });
  const nativeRpc = rpcAdapter(tool);
  const nativeAgent = agentAdapter(tool);
  assert.equal(Object.isFrozen(rpcDefinition), true);
  assert.equal(rpcDefinition.capability, metadata);
  assert.equal(agentDefinition.capability, metadata);
  assert.equal(rpcDefinition.inputSchema, inputSchema);
  assert.equal(agentDefinition.outputSchema, outputSchema);
  assert.equal(nativeRpc.method, 'trigger_inspect');
  assert.equal(nativeAgent.function.name, 'trigger_inspect');
  assert.equal(await nativeRpc.call({ triggerId: 't1' }, { scopeId: 'tenant-a' }), outcome);
  assert.equal(await nativeAgent.run({ triggerId: 't1' }, { scopeId: 'tenant-a' }), outcome);
  assert.deepEqual(outcome.result.reference, { id: 'ref:1' });
});

test('host denial and native interruptions propagate untouched, never as successful results', async () => {
  const denial = { ok: false, error: { code: 'POLICY_DENY', message: 'no permission' } };
  const denied = createPortableToolAdapter({
    makeTool: view => ({ run: view.execute }),
  })(portable(async () => denial));
  assert.equal(await denied.run({}, {}), denial);
  const interrupt = new Error('host approval suspended');
  interrupt.code = 'HOST_INTERRUPT';
  const interrupted = createPortableToolAdapter({
    makeTool: view => ({ run: view.execute }),
  })(portable(async () => { throw interrupt; }));
  await assert.rejects(interrupted.run({}, {}), error => error === interrupt);
});

test('allowlisted bind remains the only registration path, rejects unknown IDs before adaptation', () => {
  let adapted = 0;
  let registered = 0;
  const adapter = createPortableToolAdapter({
    makeTool(view) {
      adapted++;
      return { name: view.name, run: view.execute };
    },
  });
  const integration = { tools: [portable(async () => ({ ok: true }))], close: async () => {} };
  const none = bindEmbeddedRuntimeIntegration(integration, {
    adapt: adapter,
    register: () => { registered++; },
    capabilityIds: [],
  });
  assert.deepEqual(none, []);
  assert.equal(adapted, 0);
  assert.equal(registered, 0);
  assert.throws(() => bindEmbeddedRuntimeIntegration(integration, {
    adapt: adapter,
    register: () => { registered++; },
    capabilityIds: ['unknown.capability'],
  }), /unknown EI capability/);
  assert.equal(adapted, 0);
  assert.equal(registered, 0);
  const allowed = bindEmbeddedRuntimeIntegration(integration, {
    adapt: adapter,
    register: () => { registered++; },
    capabilityIds: [metadata.id],
  });
  assert.equal(allowed.length, 1);
  assert.equal(adapted, 1);
  assert.equal(registered, 1);
});

test('omitted optional outputSchema stays omitted; mutation control cannot be synthesized', async () => {
  const tool = portable(async () => ({ ok: false, error: { code: 'OWNER_REQUIRED', message: 'owner only' } }));
  delete tool.outputSchema;
  let view;
  const adapter = createPortableToolAdapter({
    makeTool(input) { view = input; return { invoke: input.execute }; },
  });
  const host = adapter(tool);
  assert.equal(Object.hasOwn(view, 'outputSchema'), false);
  assert.equal(Object.hasOwn(view, 'control'), false);
  assert.equal(Object.hasOwn(view, 'owner'), false);
  assert.equal((await host.invoke({}, {})).ok, false);
});
