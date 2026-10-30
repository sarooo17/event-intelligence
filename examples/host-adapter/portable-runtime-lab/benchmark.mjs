// Bounded same-host A/B microbenchmark. NOT an adapter-only overhead
// isolation, developer productivity study, database SLO or production signoff.
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRuntimeHost } from './host.mjs';
import { attachManually } from './manual-bridge.mjs';
import { attachEventIntelligence } from './ei-bridge.mjs';

const WARMUPS = 60, SAMPLES = 250;
const percentiles = (points) => {
  const sorted = [...points].sort((a, b) => a - b);
  const at = q => Number(sorted[Math.ceil(sorted.length * q) - 1].toFixed(5));
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
};

async function measure(name, attach) {
  const dir = await mkdtemp(join(tmpdir(), 'ei-portable-perf-'));
  const host = makeRuntimeHost();
  host.addMember({ org: 'org-A', workspace: 'A', team: 'ops', user: 'alice' });
  host.addAgent({ id: 'agent-a', org: 'org-A', workspace: 'A',
    team: 'ops', owner: 'alice' });
  const ticket = host.issueTicket({ org: 'org-A', workspace: 'A',
    team: 'ops', user: 'alice', agentId: 'agent-a' });
  const rssBefore = process.memoryUsage().rss;
  const start = performance.now();
  try {
    const ei = await attach(host, {
      dataDir: dir, capabilityIds: ['event-intelligence.trigger.list'],
      env: { TEMPORAL_TICK_MS: '100000', WAKE_RETRY_TICK_MS: '100000' },
    });
    const initMs = performance.now() - start;
    const operation = ei.tools.find(x =>
      x.capability.id === 'event-intelligence.trigger.list').name;
    const all = [];
    for (let i = 0; i < WARMUPS + SAMPLES; i++) {
      const t = performance.now();
      const result = await host.invoke(operation, {}, ticket);
      const elapsed = performance.now() - t;
      if (result.trust !== 'untrusted-external' ||
          result.result?.ok !== true ||
          result.result?.data?.total !== 0)
        throw new Error('Benchmark refused unexpected tool result');
      if (i >= WARMUPS) all.push(elapsed);
    }
    return {
      variant: name,
      initializedWithinMs: Number(initMs.toFixed(4)),
      callLatencyMs: percentiles(all),
      maxObservedCallMs: Number(Math.max(...all).toFixed(5)),
      rssDeltaAfterCallsBytes: process.memoryUsage().rss - rssBefore,
      samples: all.length, warmups: WARMUPS,
    };
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// Both orders partially counteract first-module/cache/IO warmup bias.
// Report individual samples, NOT a marketing speed-up from noisy CI hosts.
const results = [];
for (const [name, attach] of [
  ['manual-A', attachManually],
  ['binder-A', attachEventIntelligence],
  ['binder-B', attachEventIntelligence],
  ['manual-B', attachManually],
]) results.push(await measure(name, attach));

console.log(JSON.stringify({
  schema: 'ei.host-native-ab-measurement.v1',
  sampleDescription: 'EI trigger.list; same in-memory native host, JSONL EI scope',
  npmVersion: 'mcp-event-intelligence@0.12.0-next.0',
  results,
  scope: {
    currentProcessOnly: true,
    isolatesAdapterOnlyOverhead: false,
    includesHostPolicyAndEIStore: true,
    independentRealConsumer: false,
    baselineVsCandidateDevTimeMeasured: false,
    productionSloCertified: false,
  },
}, null, 2));
