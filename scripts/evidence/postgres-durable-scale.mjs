#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PostgresEventStore } from '../lib/postgres-event-store.mjs';

/**
 * Real PostgreSQL durable-trigger registration/list/wake benchmark.
 *
 * Run only with explicit opt-in and an isolated DB role. This deliberately
 * does not claim to measure provider latency or end-to-end agent delivery.
 * See docs/POSTGRES-SCALE-BENCHMARK.md.
 */
const PROFILES = Object.freeze({
  smoke: 16,
  '1k': 1000,
  '10k': 10000,
  '100k': 100000,
});

function fail(message) {
  const error = new Error(message);
  error.code = 'EI_PG_BENCHMARK_CONFIG_INVALID';
  throw error;
}

function option(name, fallback) {
  const prefix = '--' + name;
  const at = process.argv.indexOf(prefix);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

function boundedInt(name, fallback, max) {
  const raw = option(name, String(fallback));
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) {
    fail('--' + name + ' must be a positive integer');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) {
    fail('--' + name + ' maximum is ' + max);
  }
  return value;
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? null;
}

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: quantile(sorted, 0.50),
    p95Ms: quantile(sorted, 0.95),
    p99Ms: quantile(sorted, 0.99),
    maxMs: sorted.at(-1),
    meanMs: sorted.reduce((sum, x) => sum + x, 0) / sorted.length,
  };
}

async function time(work, timings) {
  const start = performance.now();
  const result = await work();
  timings.push(performance.now() - start);
  return result;
}

function definition(n) {
  return {
    triggerId: 'bench-trigger-' + n,
    version: '1',
    conditionOnly: true,
    clauses: [{
      id: 'signal',
      event: 'benchmark.signal',
      arguments: {},
      where: [],
    }],
    pattern: { version: '2', root: { kind: 'event', ref: 'signal' } },
    withinMs: 60_000,
  };
}

const prefix = 'ei_perf_' + randomBytes(6).toString('hex');
const suffixes = ['metadata', 'leases', 'history', 'records', 'counters'];

async function main() {
  if (process.env.EI_PG_BENCHMARK_CONFIRM !== 'YES_ISOLATED') {
    fail('set EI_PG_BENCHMARK_CONFIRM=YES_ISOLATED for isolated benchmark data');
  }
  if (!process.env.POSTGRES_URL) fail('POSTGRES_URL is required');
  const profile = String(option('profile', 'smoke'));
  if (!Object.hasOwn(PROFILES, profile)) {
    fail('--profile must be smoke, 1k, 10k or 100k');
  }
  const triggerCount = PROFILES[profile];
  const wakes = boundedInt('wakes', profile === 'smoke' ? 4 : 128, 1000);
  const concurrency = boundedInt('concurrency', 4, 16);
  const pg = await import('pg');
  const Pool = pg.Pool ?? pg.default?.Pool;
  if (!Pool) fail('pg Pool driver unavailable');
  const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    max: concurrency + 2,
  });
  const startCpu = process.cpuUsage();
  const startMemory = process.memoryUsage();
  const runStarted = performance.now();
  let phase = 'initialization';
  const record = {
    schema: 'event-intelligence.postgres-durable-scale.v1',
    generatedAt: new Date().toISOString(),
    profile, triggerCount, wakes, concurrency, prefix,
    runtime: { node: process.version, platform: process.platform },
    metrics: {},
  };
  try {
    const store = new PostgresEventStore({ pool, tablePrefix: prefix });
    await store.init();
    record.runtime.postgresVersion = (
      await pool.query('SHOW server_version')
    ).rows[0].server_version;

    const registerMs = [];
    let next = 0;
    phase = 'register';
    const registerStart = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = next++;
        if (index >= triggerCount) return;
        await time(() => store.putTrigger(definition(index)), registerMs);
      }
    }));
    const registerWallMs = performance.now() - registerStart;
    record.metrics.register = {
      latency: stats(registerMs),
      wallMs: registerWallMs,
      triggersPerSecond: triggerCount * 1000 / registerWallMs,
    };

    phase = 'list';
    const listMs = [];
    // Warm + measured complete authoritative reads: no synthetic list count.
    for (let i = 0; i < 3; i++) {
      const rows = await time(() => store.listTriggers(), listMs);
      if (rows.length !== triggerCount) {
        throw new Error('Durable trigger count mismatch: ' + rows.length);
      }
    }
    record.metrics.listAll = {
      latency: stats(listMs),
      durableRowsVerified: triggerCount,
    };

    phase = 'wake';
    const ensureMs = [], claimMs = [], finishMs = [];
    for (let i = 0; i < wakes; i++) {
      const wakeId = 'benchmark-wake-' + i;
      const now = new Date(Date.UTC(2026, 9, 10, 10, 0, 0) + i * 10_000).toISOString();
      await time(() => store.ensureWakeDelivery({
        wakeId, matchId: 'benchmark-match-' + i,
        triggerId: 'bench-trigger-' + (i % triggerCount),
        triggerVersion: '1', runtime: 'benchmark-host', now,
      }), ensureMs);
      const claimed = await time(() => store.claimWakeDelivery(wakeId, {
        workerId: 'benchmark-worker', now, leaseMs: 10_000,
      }), claimMs);
      if (!claimed) throw new Error('Wake claim missing: ' + wakeId);
      const completed = await time(() => store.completeWakeDelivery(wakeId, {
        workerId: 'benchmark-worker',
        attemptCount: claimed.attemptCount,
        runtimeReceiptId: 'benchmark-receipt-' + i,
        now: new Date(Date.parse(now) + 100).toISOString(),
      }), finishMs);
      if (completed.status !== 'delivered') {
        throw new Error('Wake delivery not persisted: ' + wakeId);
      }
    }
    record.metrics.wakeEnsure = stats(ensureMs);
    record.metrics.wakeClaim = stats(claimMs);
    record.metrics.wakeComplete = stats(finishMs);

    phase = 'storage';
    const sizes = {};
    for (const suffix of suffixes) {
      const name = prefix + '_' + suffix;
      const result = await pool.query(
        'SELECT pg_total_relation_size($1::regclass)::bigint AS bytes',
        [name],
      );
      sizes[suffix] = Number(result.rows[0].bytes);
    }
    record.metrics.storageBytes = sizes;
    record.metrics.storageTotalBytes =
      Object.values(sizes).reduce((sum, x) => sum + x, 0);
    const cpu = process.cpuUsage(startCpu);
    record.metrics.cpuMs = {
      user: cpu.user / 1000,
      system: cpu.system / 1000,
    };
    record.metrics.memory = {
      rssBefore: startMemory.rss,
      rssAfter: process.memoryUsage().rss,
      heapUsedBefore: startMemory.heapUsed,
      heapUsedAfter: process.memoryUsage().heapUsed,
    };
    record.metrics.totalWallMs = performance.now() - runStarted;
    record.status = 'completed';
    console.log(JSON.stringify(record, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      schema: record.schema,
      profile,
      phase,
      status: 'failed',
      code: error?.code ?? 'EI_PG_BENCHMARK_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  } finally {
    // Only generated, uniquely prefixed tables can be dropped. Use an isolated
    // service account/database: this is not a backup or retention operation.
    try {
      for (const suffix of suffixes) {
        const identifier = '"' + prefix + '_' + suffix + '"';
        await pool.query('DROP TABLE IF EXISTS ' + identifier + ' CASCADE');
      }
    } catch (error) {
      console.error('Benchmark cleanup failed for prefix ' + prefix + ': ' +
        (error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}

await main();
