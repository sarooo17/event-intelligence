import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { PostgresEventStore } from '../lib/postgres-event-store.mjs';

// Standalone, operator-opt-in, isolated PostgreSQL query-plan experiment.
// This script does NOT migrate an existing database or modify a production
// EI schema. Its SQL mirrors candidate selection proposed separately in #208.
const PREFIX = 'ei_plan_' + randomBytes(5).toString('hex');
const TABLES = ['metadata', 'counters', 'leases', 'history', 'records'];
const CONFIRM = 'YES_ISOLATED';
let pool = null;
let stage = 'configuration';
const failures = [];

function numberFlag(name, fallback, max) {
  const flag = '--' + name;
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const raw = process.argv[i + 1];
  if (!raw || !/^[0-9]+$/.test(raw)) {
    throw new Error(flag + ' needs a positive integer');
  }
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error(flag + ' must be an integer between 1 and ' + max);
  }
  return number;
}

function redact(error, at) {
  return {
    phase: at,
    code: typeof error?.code === 'string'
      ? error.code : 'EI_PG_QUERY_PLAN_FAILED',
    message: String(error?.message ?? error)
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]')
      .slice(0, 450),
  };
}

function trigger(slot, sources) {
  const source = slot % sources;
  return {
    triggerId: 'source-plan-' + String(slot).padStart(6, '0'),
    version: '1',
    conditionOnly: true,
    clauses: [{
      id: 'changed',
      event: 'fixture.source.' + source + '.changed',
      ...(slot % 7 === 0 ? {} : { serverId: 'fixture-mcp' }),
      arguments: {},
      where: [{ path: 'slot', op: 'eq', value: slot }],
    }],
    pattern: { version: '2', root: { kind: 'event', ref: 'changed' } },
    lifecycle: { oneShot: false, cooldownMs: 0, completeOnGoal: false },
    withinMs: 60000,
  };
}

function exceptional(kind, lifecycle) {
  return {
    triggerId: 'source-plan-lifecycle-' + kind,
    version: '1',
    target: { runtime: 'fixture-host', kind: 'task', id: kind },
    clauses: [{
      id: 'elsewhere', event: 'irrelevant.source.event',
      arguments: {}, where: [],
    }],
    pattern: { version: '2', root: { kind: 'event', ref: 'elsewhere' } },
    lifecycle, withinMs: 60000,
  };
}

function unwrap(row) {
  const value = row?.['QUERY PLAN'];
  assert.ok(Array.isArray(value) && value.length === 1, 'invalid JSON EXPLAIN');
  assert.ok(value[0]?.Plan, 'missing plan');
  return value[0];
}

function planNodes(node, output = []) {
  output.push({
    type: node['Node Type'],
    relation: node['Relation Name'] ?? null,
    indexName: node['Index Name'] ?? null,
    actualRows: node['Actual Rows'],
    sharedHitBlocks: node['Shared Hit Blocks'] ?? 0,
    sharedReadBlocks: node['Shared Read Blocks'] ?? 0,
  });
  for (const child of node.Plans ?? []) planNodes(child, output);
  return output;
}

const querySql = (table) =>
  'SELECT record_key, payload FROM ' + table +
  ' WHERE scope_id = $1 AND kind = $2 AND (' +
  " (payload->'lifecycle'->>'expiresAt' IS NOT NULL)" +
  " OR (payload->'lifecycle'->>'leaseUntil' IS NOT NULL)" +
  " OR (payload->'lifecycle'->>'oneShot' = 'true')" +
  " OR (payload->'lifecycle' ? 'maxFirings')" +
  ' OR (' +
  " payload->'clauses' @> $3::jsonb" +
  ' AND EXISTS (' +
  " SELECT 1 FROM jsonb_array_elements(payload->'clauses') AS clause" +
  " WHERE clause->>'event' = $4" +
  " AND (NOT clause ? 'serverId'" +
  " OR COALESCE(clause->>'serverId', '') = ''" +
  " OR clause->>'serverId' = $5)" +
  ' )' +
  ' )' +
  ') ORDER BY record_key';

async function measure(sql, args, iterations) {
  const times = [];
  let lastPlan = null;
  let expectedKeys = null;
  // Alternate cold(ish) and warmed measurements in one database. This is a
  // bounded plan inspection, NOT an A/B latency or SLO certification.
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const rows = (await pool.query(sql, args)).rows;
    times.push(performance.now() - start);
    const keys = rows.map(row => row.record_key);
    if (expectedKeys) assert.deepEqual(keys, expectedKeys);
    else expectedKeys = keys;
    const explain = await pool.query(
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, args,
    );
    lastPlan = unwrap(explain.rows[0]);
  }
  return {
    returned: expectedKeys.length,
    keys: expectedKeys,
    queryWallMs: times.map(x => Number(x.toFixed(3))),
    explain: {
      planningMs: lastPlan['Planning Time'],
      executionMs: lastPlan['Execution Time'],
      nodes: planNodes(lastPlan.Plan),
      plan: lastPlan.Plan,
    },
  };
}

try {
  if (process.env.EI_PG_QUERY_PLAN_CONFIRM !== CONFIRM) {
    throw new Error('Set EI_PG_QUERY_PLAN_CONFIRM=YES_ISOLATED to run');
  }
  if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL is required');
  const triggers = numberFlag('triggers', 1000, 10000);
  const sources = numberFlag('sources', 20, 64);
  const samples = numberFlag('samples', 3, 8);
  if (sources > triggers) throw new Error('--sources cannot exceed --triggers');

  const { Pool } = await import('pg');
  const pgVersion = createRequire(import.meta.url)('pg/package.json').version;
  pool = new Pool({
    connectionString: process.env.POSTGRES_URL, max: 4,
    query_timeout: 15000, statement_timeout: 15000,
    connectionTimeoutMillis: 5000,
  });
  stage = 'setup';
  const scopeId = 'candidate-plan-tenant-a';
  const store = new PostgresEventStore({
    pool, scopeId, tablePrefix: PREFIX,
  });
  await store.init();
  for (let i = 0; i < triggers; i++) {
    await store.putTrigger(trigger(i, sources));
  }
  const exceptionalDefs = [
    exceptional('expires', { expiresAt: '2020-01-01T00:00:00.000Z' }),
    exceptional('lease', { leaseUntil: '2020-01-01T00:00:00.000Z' }),
    exceptional('once', { oneShot: true }),
    exceptional('count', { maxFirings: 1 }),
  ];
  for (const def of exceptionalDefs) await store.putTrigger(def);
  // Same name in a different scope must NEVER appear in candidate results.
  const foreign = await store.forScope('candidate-plan-tenant-b');
  await foreign.putTrigger(trigger(20000, sources));
  // Nonmatching server ID must be excluded by exact source clause filtering.
  const wrongServer = trigger(20001, sources);
  wrongServer.clauses[0].serverId = 'unrelated-mcp-server';
  wrongServer.clauses[0].event = 'fixture.source.0.changed';
  await store.putTrigger(wrongServer);

  await pool.query('ANALYZE ' + store.records);
  const baselineSql = 'SELECT record_key, payload FROM ' + store.records +
    ' WHERE scope_id = $1 AND kind = $2 ORDER BY record_key';
  const sql = querySql(store.records);
  const args = [scopeId, 'trigger',
    JSON.stringify([{ event: 'fixture.source.0.changed' }]),
    'fixture.source.0.changed', 'fixture-mcp'];
  const expectedPerName = Math.floor((triggers - 1) / sources) + 1;
  const expectedCandidates = expectedPerName + exceptionalDefs.length;

  stage = 'before-gin';
  const all = await measure(baselineSql, args.slice(0, 2), samples);
  const before = await measure(sql, args, samples);
  assert.equal(all.returned, triggers + exceptionalDefs.length + 1);
  assert.equal(before.returned, expectedCandidates,
    'candidate query must include matching/wildcard + expiry/completion only');
  assert.ok(before.keys.every(k => all.keys.includes(k)));
  assert.ok(!before.keys.some(k => k.endsWith('020001')),
    'wrong-server trigger cannot enter candidate superset');

  stage = 'isolated-index';
  const indexName = PREFIX + '_clauses_gin';
  await pool.query(
    'CREATE INDEX "' + indexName + '" ON ' + store.records +
    " USING GIN ((payload->'clauses') jsonb_path_ops)" +
    " WHERE kind = 'trigger'",
  );
  await pool.query('ANALYZE ' + store.records);

  stage = 'after-gin';
  const after = await measure(sql, args, samples);
  assert.deepEqual(after.keys, before.keys,
    'physical index must not alter candidate output');
  const version = await pool.query('SHOW server_version');
  const nodesBefore = before.explain.nodes;
  const nodesAfter = after.explain.nodes;
  const report = {
    schema: 'event-intelligence.pg-source-query-plan.v1',
    status: 'passed',
    environment: {
      commit: process.env.BENCH_SOURCE_COMMIT ?? null,
      runner: process.env.RUNNER_OS ?? null,
      node: process.version,
      postgres: version.rows[0]?.server_version ?? null,
      pgDriver: pgVersion,
    },
    workload: {
      triggers, sources, samples, scopeCount: 2,
      lifecycleExceptionalTriggers: exceptionalDefs.length,
      wrongServerTriggers: 1,
      candidateEventName: 'fixture.source.0.changed',
      candidateServerId: 'fixture-mcp',
      sourceNameCandidatesExpected: expectedPerName,
    },
    checks: {
      allTenantDefinitions: all.returned,
      expectedCandidates, beforeCandidates: before.returned,
      afterCandidates: after.returned,
      exactSameKeysPrePostIndex: true,
      otherTenantExcluded: true,
      wrongServerExcluded: true,
    },
    results: {
      baselineAllDefinitions: {
        count: all.returned,
        queryWallMs: all.queryWallMs,
        planNodes: all.explain.nodes,
      },
      sourceQueryWithoutGin: {
        count: before.returned,
        queryWallMs: before.queryWallMs,
        planningMs: before.explain.planningMs,
        executionMs: before.explain.executionMs,
        nodes: nodesBefore,
        usedGinIndex: nodesBefore.some(n => n.indexName === indexName),
      },
      sourceQueryWithDisposableGin: {
        count: after.returned,
        queryWallMs: after.queryWallMs,
        planningMs: after.explain.planningMs,
        executionMs: after.explain.executionMs,
        nodes: nodesAfter,
        usedGinIndex: nodesAfter.some(n => n.indexName === indexName),
      },
    },
    disclosure: {
      productionMigrationPerformed: false,
      indexUsedOnlyInDisposableFixture: true,
      testsExactlyCurrentPr208Query: true,
      performanceSloCertified: false,
      profilingDoesNotProveStableSpeedup: true,
      provenance: 'EXPLAIN ANALYZE on isolated fixture; cache and shared runner may vary',
    },
  };
  // No event payloads, source arguments, credentials or private DSNs.
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  failures.push(redact(error, stage));
} finally {
  stage = 'cleanup';
  if (pool) {
    for (const suffix of TABLES) {
      try {
        await pool.query(
          'DROP TABLE IF EXISTS "' + PREFIX + '_' + suffix + '" CASCADE',
        );
      } catch (error) {
        failures.push(redact(error, stage));
      }
    }
    try { await pool.end(); }
    catch (error) { failures.push(redact(error, 'pool-close')); }
  }
}
if (failures.length) {
  console.error(JSON.stringify({
    schema: 'event-intelligence.pg-source-query-plan.v1',
    status: 'failed',
    failures,
  }));
  process.exitCode = 1;
}
