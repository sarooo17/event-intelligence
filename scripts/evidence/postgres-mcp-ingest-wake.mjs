#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { PostgresEventStore } from '../lib/postgres-event-store.mjs';
import { CompositeEventConsumer } from '../lib/composite-event-consumer.mjs';
import { CompositeWakeCoordinator } from '../lib/composite-wake-coordinator.mjs';
import { CompositeTriggerEngine } from '../../dist/src/composite/engine.js';

// Measured: accepted MCP-shaped event -> normalization -> Pattern v2 match
// -> durable PG claim and EI wake -> host-owned (local fake) receipt.
// NOT measured: wire transport, remote provider delivery, real host execution.
const TABLES = ['metadata', 'leases', 'history', 'records', 'counters'];
const prefix = 'ei_pipeline_' + randomBytes(6).toString('hex');
const scopeId = 'pipeline-fixture-' + randomBytes(4).toString('hex');
const SCHEMA = 'event-intelligence.postgres-mcp-ingest-wake.v1';

function fail(message) {
  const error = new Error(message);
  error.code = 'EI_PG_PIPELINE_CONFIG_INVALID';
  throw error;
}
function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  return at === -1 ? fallback : process.argv[at + 1];
}
function numberArg(name, fallback, max) {
  const raw = arg(name, String(fallback));
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw) ||
      Number(raw) > max || !Number.isSafeInteger(Number(raw))) {
    fail('--' + name + ' must be a positive integer <= ' + max);
  }
  return Number(raw);
}
function stats(numbers) {
  assert.ok(numbers.length > 0);
  const sorted = [...numbers].sort((a, b) => a - b);
  const q = value => sorted[Math.min(sorted.length - 1,
    Math.max(0, Math.ceil(value * sorted.length) - 1))];
  return {
    samples: sorted.length,
    p50Ms: q(0.5),
    p95Ms: q(0.95),
    p99Ms: q(0.99),
    maxMs: sorted.at(-1),
  };
}
function definition(slot) {
  return {
    triggerId: 'pipeline-slot-' + slot,
    version: '1',
    clauses: [{
      id: 'changed',
      event: 'pipeline.fixture.changed',
      arguments: {},
      where: [{ path: 'slot', op: 'eq', value: slot }],
    }],
    pattern: { version: '2', root: { kind: 'event', ref: 'changed' } },
    withinMs: 60_000,
    lifecycle: {
      oneShot: false, cooldownMs: 0, completeOnGoal: false,
    },
    target: {
      runtime: 'fixture-host',
      kind: 'task',
      id: 'fixture-task-' + slot,
    },
  };
}
function occurrence(index, slot, epoch) {
  return {
    eventId: 'pipeline-source-event-' + index,
    name: 'pipeline.fixture.changed',
    timestamp: new Date(epoch + index).toISOString(),
    data: { slot, value: index, correlation: 'partition-' + slot },
  };
}
function cleanError(error, phase) {
  const message = String(error?.message ?? error)
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]');
  return {
    phase,
    code: typeof error?.code === 'string' ? error.code : 'EI_PG_PIPELINE_FAILED',
    message: message.slice(0, 500),
  };
}

let pool = null;
let recoveredPool = null;
let stage = 'configuration';
const failed = [];
let record = null;
try {
  if (process.env.EI_PG_PIPELINE_CONFIRM !== 'YES_ISOLATED') {
    fail('set EI_PG_PIPELINE_CONFIRM=YES_ISOLATED for disposable PostgreSQL tables');
  }
  if (!process.env.POSTGRES_URL) fail('POSTGRES_URL is required');
  const triggers = numberArg('triggers', 8, 64);
  const noise = numberArg('noise', 4, 64);
  const replays = numberArg('replays', 2, triggers);
  const { Pool } = await import('pg');
  const driverVersion = createRequire(import.meta.url)('pg/package.json').version;
  if (typeof Pool !== 'function') fail('pg Pool driver unavailable');
  pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    max: 4, query_timeout: 5000, statement_timeout: 5000,
    connectionTimeoutMillis: 5000,
  });
  stage = 'setup';
  const store = new PostgresEventStore({ pool, scopeId, tablePrefix: prefix });
  await store.init();
  const engine = new CompositeTriggerEngine(store);
  for (let i = 0; i < triggers; i++) await engine.register(definition(i));

  const measurements = { ingestToMatch: [], matchToWake: [], ingestToWake: [] };
  const hostReceipts = new Map();
  let hostCalls = 0;
  const coordinator = new CompositeWakeCoordinator({
    store,
    triggerEngine: engine,
    workerId: 'pipeline-benchmark-worker',
    deliverer: async packet => {
      hostCalls++;
      assert.equal(packet.target.runtime, 'fixture-host');
      assert.ok(packet.trigger_match_id);
      assert.equal(packet.source_event_refs.length, 1);
      assert.ok(!Object.hasOwn(packet.source_event_refs[0], 'data'),
        'host evidence must be reference-only');
      const receiptId = 'host-receipt:' + packet.trigger_match_id;
      assert.equal(hostReceipts.has(packet.trigger_match_id), false,
        'duplicate host continuation for one logical match');
      hostReceipts.set(packet.trigger_match_id, receiptId);
      return { runtimeReceiptId: receiptId };
    },
  });
  let matchedAt = null;
  const measuredEngine = {
    ingest: async event => {
      const result = await engine.ingest(event);
      if (result.some(row => row.matched && !row.fired)) matchedAt = performance.now();
      return result;
    },
  };
  const consumer = new CompositeEventConsumer({
    store, triggerEngine: measuredEngine, wakeCoordinator: coordinator,
  });
  const baseEpoch = Date.now() - 1000;
  const baselineCpu = process.cpuUsage();
  const baselineMemory = process.memoryUsage();
  const matched = new Set();
  const wakeIds = new Set();
  const expectedReceipts = new Map();
  stage = 'measured-ingest-match-wake';
  const started = performance.now();
  for (let i = 0; i < triggers; i++) {
    const begin = performance.now();
    matchedAt = null;
    const result = await consumer.ingestMcpOccurrence({
      event: occurrence(i, i, baseEpoch),
      serverId: 'synthetic-mcp-source',
      provider: 'benchmark-fixture',
      traceId: 'pipeline-trace-' + i,
    });
    const end = performance.now();
    assert.ok(matchedAt !== null, 'no Pattern match observed at i=' + i);
    assert.equal(result.results.filter(row => row.matched).length, 1);
    assert.equal(result.deliveries.length, 1);
    assert.equal(result.deliveries[0].status, 'wake_delivered');
    const match = result.results.find(row => row.matched).match;
    assert.equal(match.triggerId, 'pipeline-slot-' + i);
    assert.ok(!matched.has(match.matchId), 'duplicate logical match ID');
    matched.add(match.matchId);
    assert.ok(result.deliveries[0].wakeId);
    wakeIds.add(result.deliveries[0].wakeId);
    assert.equal(result.deliveries[0].runtimeReceiptId,
      hostReceipts.get(match.matchId));
    expectedReceipts.set(result.deliveries[0].wakeId,
      result.deliveries[0].runtimeReceiptId);
    measurements.ingestToMatch.push(matchedAt - begin);
    measurements.matchToWake.push(end - matchedAt);
    measurements.ingestToWake.push(end - begin);
  }
  const measuredWall = performance.now() - started;
  assert.equal(hostCalls, triggers);
  assert.equal(matched.size, triggers);
  assert.equal(wakeIds.size, triggers);

  stage = 'noise-and-replay';
  for (let i = 0; i < noise; i++) {
    const event = occurrence(triggers + i, -1, baseEpoch);
    const result = await consumer.ingestMcpOccurrence({
      event, serverId: 'synthetic-mcp-source',
      provider: 'benchmark-fixture', traceId: 'noise-' + i,
    });
    assert.equal(result.results.filter(row => row.matched).length, 0);
    assert.equal(result.deliveries.length, 0);
  }
  for (let i = 0; i < replays; i++) {
    const result = await consumer.ingestMcpOccurrence({
      event: occurrence(i, i, baseEpoch),
      serverId: 'synthetic-mcp-source',
      provider: 'benchmark-fixture', traceId: 'pipeline-trace-' + i,
    });
    assert.equal(result.deliveries.length, 1);
    assert.equal(result.deliveries[0].status, 'already_fired');
  }
  assert.equal(hostCalls, triggers, 'event replay or noise generated host side effect');
  stage = 'independent-pool-reopen';
  await pool.end();
  pool = null;
  recoveredPool = new Pool({ connectionString: process.env.POSTGRES_URL, max: 3 });
  const recovered = new PostgresEventStore({
    pool: recoveredPool, scopeId, tablePrefix: prefix,
  });
  await recovered.init();
  assert.equal((await recovered.listTriggers()).length, triggers);
  for (const [wakeId, receiptId] of expectedReceipts) {
    const saved = await recovered.getWakeDelivery(wakeId);
    assert.equal(saved?.status, 'delivered');
    assert.equal(saved.runtimeReceiptId, receiptId);
    assert.equal(saved.attemptCount, 1);
  }
  assert.equal(hostCalls, triggers);
  record = {
    schema: SCHEMA, status: 'completed', measuredAt: new Date().toISOString(),
    runtime: {
      node: process.version, platform: process.platform, arch: process.arch,
      postgresVersion: (await recoveredPool.query('SHOW server_version')).rows[0].server_version,
      commit: process.env.BENCH_SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? null,
      workflowTestMergeSha: process.env.BENCH_IS_PULL_REQUEST === 'true'
        ? process.env.GITHUB_SHA ?? null : null,
      pgDriverVersion: driverVersion,
    },
    workload: {
      triggers, matchingMcpOccurrences: triggers, noiseMcpOccurrences: noise,
      replayedMcpOccurrences: replays, scopeCount: 1, concurrency: 1,
      source: 'in-process synthetic MCP occurrence',
      host: 'in-process counted callback with durable PG receipt',
    },
    metrics: {
      ingestToMatch: stats(measurements.ingestToMatch),
      matchToWake: stats(measurements.matchToWake),
      ingestToWake: stats(measurements.ingestToWake),
      matchedCount: matched.size, durableWakeCount: wakeIds.size,
      hostSideEffects: hostCalls, duplicateHostSideEffects: hostCalls - matched.size,
      falsePositiveWakeCount: 0,
      measuredWallMs: measuredWall,
      measuredMatchingEventsPerSecond: triggers * 1000 / measuredWall,
      cpuMs: (() => { const delta = process.cpuUsage(baselineCpu);
        return { user: delta.user / 1000, system: delta.system / 1000 }; })(),
      rssBefore: baselineMemory.rss, rssAfter: process.memoryUsage().rss,
    },
    evidence: {
      persistedReceiptsCheckedAfterPoolReopen: expectedReceipts.size,
      transportLatencyIncluded: false, hostExecutionLatencyIncluded: false,
      productionSloCertified: false,
    },
  };
} catch (error) {
  failed.push(cleanError(error, stage));
} finally {
  const cleanupPool = recoveredPool ?? pool;
  if (cleanupPool) {
    for (const table of TABLES) {
      try {
        await cleanupPool.query(
          'DROP TABLE IF EXISTS "' + prefix + '_' + table + '" CASCADE');
      } catch (error) {
        failed.push(cleanError(error, 'cleanup'));
      }
    }
  }
  for (const candidate of new Set([pool, recoveredPool].filter(Boolean))) {
    try { await candidate.end(); }
    catch (error) { failed.push(cleanError(error, 'pool-close')); }
  }
}
if (failed.length) {
  process.stderr.write(JSON.stringify({
    schema: SCHEMA, status: 'failed', failures: failed,
  }, null, 2) + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify(record, null, 2) + '\n');
}
