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
function eventNameForSlot(slot, sourceCount) {
  return sourceCount === 1
    ? 'pipeline.fixture.changed'
    : 'pipeline.fixture.changed.' + (slot % sourceCount);
}
function definition(slot, sourceCount = 1) {
  return {
    triggerId: 'pipeline-slot-' + slot,
    version: '1',
    clauses: [{
      id: 'changed',
      event: eventNameForSlot(slot, sourceCount),
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
function occurrence(index, slot, epoch, sourceCount = 1) {
  return {
    eventId: 'pipeline-source-event-' + index,
    name: eventNameForSlot(slot, sourceCount),
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
  const triggers = numberArg('triggers', 8, 100000);
  const sourceCount = numberArg('sources', 1, 32);
  if (sourceCount > triggers) {
    fail('--sources cannot exceed --triggers: each named source must have at least one registered definition');
  }
  // Distinguish eligible active trigger population from sampled events.
  // 1000 eligible definitions scanning 16 events does NOT mean 1000 matches.
  const events = numberArg('events', triggers, triggers);
  const noise = numberArg('noise', 4, 64);
  const replays = numberArg('replays', 2, events);
  // A 1000x1000 event/trigger accidental run is materially different
  // from our approved 1000x16 fixture. Large populations require explicit
  // bounded sampling, rather than silently defaulting to 1000 events.
  if (triggers > 64 && (
    process.argv.indexOf('--events') === -1 || events > 64
  )) fail('more than 64 triggers requires explicit --events <= 64');
  // Larger active populations require a SECOND, explicit confirmation to
  // avoid accidental expensive O(N triggers x sampled events) workloads.
  if (triggers > 1000 && process.env.EI_PG_PIPELINE_LARGE_CONFIRM !==
      'YES_ISOLATED_LARGE') {
    fail('more than 1000 triggers requires EI_PG_PIPELINE_LARGE_CONFIRM=YES_ISOLATED_LARGE');
  }
  if (triggers > 1000 && events > 16) {
    fail('more than 1000 triggers requires --events <= 16');
  }
  // Spread sampled matches across the population and, for large profiles,
  // across event-name partitions. This is a *bounded sample*, not a claim
  // about 100k simultaneous fired events or all names being sampled.
  const slotFor = index => {
    const base = Math.floor(index * triggers / events);
    return triggers > 1000
      ? Math.min(triggers - 1, base + (index % sourceCount))
      : base;
  };
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
  for (let i = 0; i < triggers; i++) {
    const item = definition(i, sourceCount);
    if (triggers > 1000) {
      // Large fixtures contain only independent single-event clauses,
      // no derived-event references or cycles. putTrigger validates the
      // exact canonical schema and inserts in O(N), avoiding the
      // register() cycle-check O(N^2) setup over 100k existing triggers.
      // The *measured ingest* still runs the unmodified real engine.
      await store.putTrigger(item);
    } else {
      await engine.register(item);
    }
  }

  // Record how many *actual* definitions the live PG candidate projection
  // returned for each measured MCP event. Total eligible population is NOT
  // the same as candidates returned after filtering by source/event name.
  const observedCandidateCounts = [];
  const measuredStoreOperations = new Map();
  const profileMethods = [
    'getTrigger', 'listTriggers', 'getTriggerState',
    'ensureWakeDelivery', 'getWakeDelivery', 'claimWakeDelivery',
    'completeWakeDelivery', 'appendWake', 'appendAudit',
    'appendDeliveredWakeIfMissing', 'latestWake', 'auditLength',
    'appendTriggerMatch', 'compareAndAppendTriggerMatch',
    'listTriggerMatchHistory', 'listTriggerMatches',
  ];
  // Profile actual awaited store calls, NEVER spoof method returns or
  // replace the persistent receipt/claim transaction implementation.
  // Metrics are inclusive per-operation timings; overlapping or nested
  // calls may not be added together as an exact critical-path breakdown.
  for (const method of profileMethods) {
    if (typeof store[method] !== 'function') continue;
    const original = store[method].bind(store);
    store[method] = async (...args) => {
      const inMeasurement = stage === 'measured-ingest-match-wake';
      if (!inMeasurement) return original(...args);
      const start = performance.now();
      try {
        return await original(...args);
      } finally {
        if (!measuredStoreOperations.has(method)) {
          measuredStoreOperations.set(method, []);
        }
        measuredStoreOperations.get(method).push(performance.now() - start);
      }
    };
  }
  const originalCandidates = store.listTriggerCandidatesForEvent.bind(store);
  store.listTriggerCandidatesForEvent = async (event) => {
    const candidates = await originalCandidates(event);
    if (stage === 'measured-ingest-match-wake') {
      observedCandidateCounts.push(candidates.length);
    }
    return candidates;
  };

  const measurements = { ingestToMatch: [], matchToWake: [], ingestToWake: [] };
  const measuredHostCallbackMs = [];
  const hostReceipts = new Map();
  let hostCalls = 0;
  const coordinator = new CompositeWakeCoordinator({
    store,
    triggerEngine: engine,
    workerId: 'pipeline-benchmark-worker',
    deliverer: async packet => {
      const hostStart = performance.now();
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
      if (stage === 'measured-ingest-match-wake') {
        measuredHostCallbackMs.push(performance.now() - hostStart);
      }
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
  const originalDeliveriesByIndex = new Map();
  stage = 'measured-ingest-match-wake';
  const started = performance.now();
  for (let i = 0; i < events; i++) {
    const begin = performance.now();
    matchedAt = null;
    const result = await consumer.ingestMcpOccurrence({
      event: occurrence(i, slotFor(i), baseEpoch, sourceCount),
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
    assert.equal(match.triggerId, 'pipeline-slot-' + slotFor(i));
    assert.ok(!matched.has(match.matchId), 'duplicate logical match ID');
    matched.add(match.matchId);
    assert.ok(result.deliveries[0].wakeId);
    wakeIds.add(result.deliveries[0].wakeId);
    assert.equal(result.deliveries[0].runtimeReceiptId,
      hostReceipts.get(match.matchId));
    expectedReceipts.set(result.deliveries[0].wakeId,
      result.deliveries[0].runtimeReceiptId);
    originalDeliveriesByIndex.set(i, {
      matchId: match.matchId,
      wakeId: result.deliveries[0].wakeId,
      receiptId: result.deliveries[0].runtimeReceiptId,
    });
    measurements.ingestToMatch.push(matchedAt - begin);
    measurements.matchToWake.push(end - matchedAt);
    measurements.ingestToWake.push(end - begin);
  }
  assert.equal(observedCandidateCounts.length, events,
    'one scoped candidate query must be measured for each accepted event');
  const measuredCandidateCounts = [...observedCandidateCounts];
  const measuredWall = performance.now() - started;
  const measuredCpu = process.cpuUsage(baselineCpu);
  const measuredMemory = process.memoryUsage();
  assert.equal(hostCalls, events);
  assert.equal(matched.size, events);
  assert.equal(wakeIds.size, events);

  stage = 'noise-and-replay';
  for (let i = 0; i < noise; i++) {
    const event = occurrence(triggers + i, -1, baseEpoch, sourceCount);
    const result = await consumer.ingestMcpOccurrence({
      event, serverId: 'synthetic-mcp-source',
      provider: 'benchmark-fixture', traceId: 'noise-' + i,
    });
    assert.equal(result.results.filter(row => row.matched).length, 0);
    assert.equal(result.deliveries.length, 0);
  }
  for (let i = 0; i < replays; i++) {
    const result = await consumer.ingestMcpOccurrence({
      event: occurrence(i, slotFor(i), baseEpoch, sourceCount),
      serverId: 'synthetic-mcp-source',
      provider: 'benchmark-fixture', traceId: 'pipeline-trace-' + i,
    });
    assert.equal(result.deliveries.length, 1);
    assert.equal(result.deliveries[0].status, 'already_fired');
    const original = originalDeliveriesByIndex.get(i);
    assert.ok(original, 'missing original delivery evidence');
    assert.equal(result.results.filter(row => row.matched).length, 1);
    assert.equal(result.results[0].match.matchId, original.matchId);
    assert.equal(result.deliveries[0].wakeId, original.wakeId,
      'replay must reuse original EI wake identity');
    assert.equal(result.deliveries[0].runtimeReceiptId, original.receiptId,
      'replay must reuse original host receipt identity');
  }
  assert.equal(hostCalls, events, 'event replay or noise generated host side effect');
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
  assert.equal(hostCalls, events);
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
      triggers, activeEligibleTriggerDefinitions: triggers,
      distinctEventNames: sourceCount,
      matchingMcpOccurrences: events,
      distinctMatchedTriggerDefinitions: matched.size,
      selection: 'evenly-spaced unique slots across entire registered population; event names distributed by slot modulo sources',
      noiseMcpOccurrences: noise,
      replayedMcpOccurrences: replays, scopeCount: 1, concurrency: 1,
      source: 'in-process synthetic MCP occurrence',
      host: 'in-process counted callback with durable PG receipt',
    },
    metrics: {
      ingestToMatch: stats(measurements.ingestToMatch),
      matchToWake: stats(measurements.matchToWake),
      ingestToWake: stats(measurements.ingestToWake),
      wakeStoreProfile: Object.fromEntries(
        [...measuredStoreOperations.entries()].map(([method, samples]) => [
          method,
          {
            ...stats(samples),
            totalMs: samples.reduce((total, value) => total + value, 0),
          },
        ]),
      ),
      hostCallback: stats(measuredHostCallbackMs),
      matchedCount: matched.size, durableWakeCount: wakeIds.size,
      hostSideEffects: hostCalls, duplicateHostSideEffects: hostCalls - matched.size,
      falsePositiveWakeCount: 0,
      measuredWallMs: measuredWall,
      measuredMatchingEventsPerSecond: events * 1000 / measuredWall,
      cpuMs: { user: measuredCpu.user / 1000, system: measuredCpu.system / 1000 },
      rssBefore: baselineMemory.rss, rssAfter: measuredMemory.rss,
      cpuAndRssScope: 'Node.js benchmark process only; excludes PostgreSQL service CPU/RSS',
    },
    evidence: {
      persistedReceiptsCheckedAfterPoolReopen: expectedReceipts.size,
      totalRegisteredActiveDefinitions: triggers,
      candidateDefinitionsPerMeasuredEvent: {
        samples: measuredCandidateCounts.length,
        min: Math.min(...measuredCandidateCounts),
        max: Math.max(...measuredCandidateCounts),
        average: measuredCandidateCounts.reduce((a, b) => a + b, 0) /
          measuredCandidateCounts.length,
      },
      measuredDistinctMatches: events,
      definitionReadProfile: {
        indexedReads: measuredStoreOperations.get('getTrigger')?.length ?? 0,
        fullRegistryReads: measuredStoreOperations.get('listTriggers')?.length ?? 0,
        expectedIndexedReads: events * 2,
      },
      storeOperationProfileIsInclusive: true,
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
