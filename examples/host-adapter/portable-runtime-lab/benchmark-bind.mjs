// Reproducible registration-only A/B over the EXACT SAME published EI tool catalog.
// This isolates the one-time host-tool registration path from storage, CEP,
// authorization, network and wake. It is NOT an end-to-end latency benchmark.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEventIntelligence,
  bindEmbeddedRuntimeIntegration,
} from 'mcp-event-intelligence/embedded';

const warmups = 700, samples = 2500;
const percentiles = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const value = q => Number(sorted[Math.ceil(sorted.length * q) - 1].toFixed(6));
  return { p50: value(0.50), p95: value(0.95), p99: value(0.99) };
};

// Same schema, capability filtering, pre-adaptation, and side effects.
// This manual branch intentionally duplicates EI binder behavior rather than
// deleting critical validation or throwing policy/taint handling away.
function bindManually(integration, { capabilityIds, adapt, register }) {
  if (!Array.isArray(capabilityIds) ||
      capabilityIds.some(id => typeof id !== 'string' || !id.trim()))
    throw TypeError('manual capability allowlist invalid');
  const known = new Set(integration.tools.map(tool => tool.capability.id));
  if (capabilityIds.some(id => !known.has(id)))
    throw Error('unknown EI capability');
  const allow = new Set(capabilityIds);
  const selected = integration.tools.filter(t => allow.has(t.capability.id));
  const ready = selected.map(adapt);
  for (let i = 0; i < ready.length; i++) register(ready[i], selected[i]);
  return ready;
}

function bindOnce(integration, capabilities, mode) {
  const registered = new Map();
  const callbacks = {
    capabilityIds: capabilities,
    adapt: portable => ({
      name: portable.name,
      description: portable.description,
      inputSchema: portable.inputSchema,
      capability: portable.capability.id,
      invoke: (args, context) => portable.execute(args, context),
    }),
    register: (native, portable) => {
      assert.equal(native.capability, portable.capability.id);
      if (registered.has(native.name)) throw Error('duplicate native tool');
      registered.set(native.name, native);
    },
  };
  const bind = mode === 'manual' ? bindManually : bindEmbeddedRuntimeIntegration;
  const output = bind(integration, callbacks);
  assert.equal(output.length, capabilities.length);
  assert.equal(registered.size, capabilities.length);
  return registered;
}

async function run(mode, integration, capabilities) {
  const times = [];
  for (let i = 0; i < warmups + samples; i++) {
    const start = performance.now();
    bindOnce(integration, capabilities, mode);
    const elapsed = performance.now() - start;
    if (!Number.isFinite(elapsed) || elapsed < 0)
      throw Error('MONOTONIC_CLOCK_INVALID');
    if (i >= warmups) times.push(elapsed);
  }
  return { mode, samples, warmups, registrationMs: percentiles(times) };
}

const dir = await mkdtemp(join(tmpdir(), 'ei-binder-isolated-'));
let ei;
try {
  ei = await createEventIntelligence({
    dataDir: dir,
    mcp: { list: () => [] },
    runtime: {
      deliver: ({ receiptId }) => ({ runtimeReceiptId: receiptId }),
      resolveContext: () => ({ target: { runtime: 'lab', kind: 'agent', id: 'agent-1' } }),
      control: () => ({ action: 'return',
        result: { ok: false, error: { code: 'LAB_DENIED', message: 'Host owned' } } }),
    },
    env: { TEMPORAL_TICK_MS: '100000', WAKE_RETRY_TICK_MS: '100000' },
  });
  const capabilities = ei.tools.map(tool => tool.capability.id);
  assert.equal(capabilities.length, 8);
  for (const mode of ['manual', 'binder']) {
    let effects = 0;
    const callbacks = {
      capabilityIds: [capabilities[0], 'unavailable.foreign'],
      adapt: tool => { effects++; return tool; },
      register: () => { effects++; },
    };
    assert.throws(
      () => (mode === 'manual'
        ? bindManually(ei, callbacks)
        : bindEmbeddedRuntimeIntegration(ei, callbacks)),
      /unknown EI capability/i,
    );
    assert.equal(effects, 0, 'Unknown capability must reject before side effects');
  }
  const results = [];
  // ABBA reduces one directional cache-heat advantage; still noisy.
  for (const mode of ['manual', 'binder', 'binder', 'manual']) {
    results.push(await run(mode, ei, capabilities));
  }
  console.log(JSON.stringify({
    schema: 'ei.host-kit-registration-overhead.v1',
    package: 'mcp-event-intelligence@0.12.0-next.0',
    mode: 'same actual 8 EI portable tools; in-memory host-native descriptor map',
    results,
    capabilityCount: capabilities.length,
    warmupSamplesDiscarded: warmups,
    measurementScope: {
      isolatesOneTimeToolRegistration: true,
      excludesEIInitialization: true,
      excludesNativeToolInvocation: true,
      excludesHostPolicyAndPersistence: true,
      excludesNetworkAndMcpTransport: true,
      excludesRuntimeWakeAndCEP: true,
      independentExternalConsumer: false,
      producer: 'EI-maintained, CI-run fixture',
      productionSloCertified: false,
      startupAndRSSIsolated: false,
      performanceAdvantageClaimed: false,
    },
  }, null, 2));
} finally {
  await ei?.close();
  await rm(dir, { recursive: true, force: true });
}
