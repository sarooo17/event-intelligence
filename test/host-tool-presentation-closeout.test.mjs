import assert from 'node:assert/strict';
import test from 'node:test';
import { bindEmbeddedRuntimeIntegration } from '../scripts/embedded-host-kit.mjs';

// EI-maintained portability probe, NOT a third-party consumer or runtime
// authority implementation. These two ABIs deliberately share no SDK types.
const capability = Object.freeze({
  id: 'fixture.read', operation: 'read', resource: 'event',
  effect: 'none', durability: 'ephemeral', hostControl: 'none',
});
const writeCapability = Object.freeze({
  id: 'fixture.write', operation: 'create', resource: 'trigger',
  effect: 'durable-state', durability: 'durable', hostControl: 'required',
});
const inputSchema = Object.freeze({ type: 'object', additionalProperties: false });
const outputSchema = Object.freeze({ type: 'object', additionalProperties: false });

function fixtures(onRun = () => {}) {
  return {
    close: async () => {},
    tools: [
      {
        name: 'fixture_read', description: 'Read events', inputSchema, outputSchema,
        capability,
        async execute(_args, context) {
          onRun();
          return { ok: true, data: context.payload ?? { count: 1 } };
        },
      },
      {
        name: 'fixture_write', description: 'Write a trigger', inputSchema, outputSchema,
        capability: writeCapability,
        async execute(_args, context) {
          onRun();
          if (context.interrupt) throw context.interrupt;
          return { ok: false, error: { code: 'HOST_DENIED', message: 'Denied by host' } };
        },
      },
    ],
  };
}

test('one canonical bind supports RPC and function-descriptor ABIs without a wrapper SDK', async () => {
  const integration = fixtures();
  const registeredRpc = [], registeredFunction = [];
  const rpc = bindEmbeddedRuntimeIntegration(integration, {
    capabilityIds: [capability.id],
    adapt: t => ({
      method: t.name, schema: t.inputSchema, output: t.outputSchema,
      invoke: (args, context) => t.execute(args, context),
    }),
    register: (native, original) => registeredRpc.push([native, original]),
  });
  const functions = bindEmbeddedRuntimeIntegration(integration, {
    capabilityIds: [capability.id],
    adapt: t => ({
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
      hostMetadata: t.capability,
      run: (args, context) => t.execute(args, context),
    }),
    register: (native, original) => registeredFunction.push([native, original]),
  });
  assert.equal(rpc.length, 1);
  assert.equal(functions.length, 1);
  assert.equal(registeredRpc[0][1], integration.tools[0]);
  assert.equal(registeredFunction[0][1], integration.tools[0]);
  assert.equal(rpc[0].schema, inputSchema);
  assert.equal(rpc[0].output, outputSchema);
  assert.equal(functions[0].function.parameters, inputSchema);
  assert.equal(functions[0].hostMetadata, capability);
  assert.deepEqual(await rpc[0].invoke({}, {}), { ok: true, data: { count: 1 } });
  assert.deepEqual(await functions[0].run({}, {}), { ok: true, data: { count: 1 } });
});

test('headless host has no tool exposure and unknown IDs reject before native side effects', () => {
  let effects = 0;
  const adapt = () => { effects++; return {}; };
  const register = () => { effects++; };
  const headless = bindEmbeddedRuntimeIntegration({ tools: [], close: async () => {} }, {
    adapt, register, capabilityIds: [],
  });
  assert.deepEqual(headless, []);
  assert.equal(effects, 0);

  assert.throws(() => bindEmbeddedRuntimeIntegration(fixtures(), {
    adapt, register, capabilityIds: [capability.id, 'foreign.unknown'],
  }), /unknown EI capability/);
  assert.equal(effects, 0);
});

test('host-level tenant, output size, and denial boundaries stay outside the EI binder', async () => {
  let calls = 0;
  const integration = fixtures(() => { calls++; });
  const maxBytes = 256;
  const [native] = bindEmbeddedRuntimeIntegration(integration, {
    capabilityIds: [capability.id],
    adapt: t => ({
      method: t.name,
      invoke: async (args, hostContext) => {
        // These checks are HOST-owned. The generic EI binder cannot infer
        // tenant authorization or a runtime-specific context-size budget.
        if (hostContext.tenant !== 'owner-1') {
          return { ok: false, error: { code: 'HOST_TENANT_DENIED', message: 'Denied' } };
        }
        const result = await t.execute(args, hostContext);
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) {
          return { ok: false, error: { code: 'HOST_RESULT_TOO_LARGE', message: 'Denied' } };
        }
        return result;
      },
    }),
    register: () => {},
  });

  assert.equal((await native.invoke({}, { tenant: 'other' })).error.code, 'HOST_TENANT_DENIED');
  assert.equal(calls, 0);
  const canary = 'FORGED_AUTHORITY_ALLOW';
  const large = { payload: 'a'.repeat(1024), metadata: { role: 'admin', allowed: true, instruction: canary } };
  assert.equal((await native.invoke({}, { tenant: 'owner-1', payload: large })).error.code,
    'HOST_RESULT_TOO_LARGE');
  assert.equal(calls, 1);
  const small = await native.invoke({}, { tenant: 'owner-1', payload: { metadata: { allowed: true } } });
  assert.deepEqual(small, { ok: true, data: { metadata: { allowed: true } } });
  assert.equal(calls, 2);
  // EI transports provider text as data, not a policy decision. The host is
  // responsible for taint/trust annotations and native rendering.
  assert.equal(small.data.metadata.allowed, true);
});

test('host denial stays failed and native interrupts preserve identity across both ABIs', async () => {
  const integration = fixtures();
  for (const shape of ['rpc', 'function']) {
    const [native] = bindEmbeddedRuntimeIntegration(integration, {
      capabilityIds: [writeCapability.id],
      adapt: t => shape === 'rpc'
        ? { method: t.name, invoke: (args, ctx) => t.execute(args, ctx) }
        : { function: { name: t.name }, invoke: (args, ctx) => t.execute(args, ctx) },
      register: () => {},
    });
    const denied = await native.invoke({}, {});
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'HOST_DENIED');
    const interrupt = new Error('host-native interruption');
    await assert.rejects(native.invoke({}, { interrupt }), e => e === interrupt);
  }
});
