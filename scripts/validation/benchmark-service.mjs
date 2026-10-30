#!/usr/bin/env node
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { assessPostgresProductionSloEvidence } from '../evidence/postgres-production-slo-gate.mjs';
import { verifyCampaignArtifact, verifyRawSampleArtifact } from './artifact.mjs';
import { measureRailwayInspector } from './inspector-profile.mjs';
import { MAX_POSTGRES_TABLE_PREFIX_BYTES } from '../lib/postgres-event-store.mjs';
import { bearerMatches, httpPort, listenValidationPrivateServer, parsePrivateServiceUrl, percentileStats, readJson, requiredEnv, safeError, safeIdentifier, sendJson } from './common.mjs';

const { Pool } = pg;
const HOST_TABLE = 'ei_validation_host_receipts';
const MAX_DURATION_SECONDS = 3600;
const MAX_EVENTS = 250_000;
const LOAD_BUCKET_SECONDS = 60;
const MIN_BUCKET_COVERAGE = 0.8;
const MAX_TRIGGERS = 100_000;
const MAX_CONCURRENCY = 32;
const MAX_RAW_SAMPLE_ROWS = 100_000;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const ACTIVE_CAMPAIGN_STATES = new Set(['queued', 'preparing', 'running', 'finalizing']);

export function readBenchmarkConfig(env = process.env) {
  const databaseUrl = requiredEnv(env, 'DATABASE_URL', { minLength: 12 });
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  const controlToken = requiredEnv(env, 'EI_CONTROL_TOKEN', { minLength: 32 });
  const ingestToken = requiredEnv(env, 'EI_INGEST_TOKEN', { minLength: 32 });
  const hostCallbackToken = requiredEnv(env, 'EI_HOST_CALLBACK_TOKEN', { minLength: 32 });
  if (new Set([controlToken, ingestToken, hostCallbackToken]).size !== 3) throw new Error('EI_CONTROL_TOKEN, EI_INGEST_TOKEN, and EI_HOST_CALLBACK_TOKEN must be distinct');
  const scopeBase = safeIdentifier(requiredEnv(env, 'EI_SCOPE_ID'), 'EI_SCOPE_ID');
  const tablePrefix = safeIdentifier(env.EI_TABLE_PREFIX || 'ei_validation', 'EI_TABLE_PREFIX');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablePrefix) || Buffer.byteLength(tablePrefix) > MAX_POSTGRES_TABLE_PREFIX_BYTES) throw new Error(`EI_TABLE_PREFIX must be a valid PostgreSQL prefix of at most ${MAX_POSTGRES_TABLE_PREFIX_BYTES} bytes`);
  const workers = [
    { id: 'ei-worker-a', url: parsePrivateServiceUrl(requiredEnv(env, 'EI_WORKER_A_URL'), 'EI_WORKER_A_URL', { allowLocal: env.EI_VALIDATION_ALLOW_LOCAL_HTTP === 'true' }) },
    { id: 'ei-worker-b', url: parsePrivateServiceUrl(requiredEnv(env, 'EI_WORKER_B_URL'), 'EI_WORKER_B_URL', { allowLocal: env.EI_VALIDATION_ALLOW_LOCAL_HTTP === 'true' }) },
  ];
  if (workers[0].url === workers[1].url) throw new Error('EI_WORKER_A_URL and EI_WORKER_B_URL must identify distinct services');
  const artifactDir = resolve(env.EI_ARTIFACT_DIR || '/data/artifacts');
  const port = httpPort(env);
  const wakeSettleTimeoutSeconds = Number(env.EI_WAKE_SETTLE_TIMEOUT_SECONDS || 120);
  if (!Number.isSafeInteger(wakeSettleTimeoutSeconds) || wakeSettleTimeoutSeconds < 1 || wakeSettleTimeoutSeconds > 900) throw new Error('EI_WAKE_SETTLE_TIMEOUT_SECONDS must be an integer from 1 to 900');
  const allow100k = env.EI_ALLOW_100K === 'true';
  const faultToken = env.EI_FAULT_TOKEN || '';
  if (faultToken && faultToken.length < 32) throw new Error('EI_FAULT_TOKEN must have at least 32 characters');
  if (faultToken && [controlToken, ingestToken, hostCallbackToken].includes(faultToken)) throw new Error('EI_FAULT_TOKEN must be distinct from service authentication tokens');
  return { databaseUrl, controlToken, ingestToken, hostCallbackToken, scopeBase, tablePrefix, workers, artifactDir, port, wakeSettleTimeoutSeconds, allow100k, faultToken };
}

function triggerDefinition(slot) {
  return {
    triggerId: `railway-slot-${slot}`, version: '1',
    clauses: [{ id: 'changed', event: `railway.validation.changed.${slot}`, arguments: {}, where: [{ path: 'slot', op: 'eq', value: slot }] }],
    pattern: { version: '2', root: { kind: 'event', ref: 'changed' }, partitionBy: [{ key: 'benchmark-partition', fields: [{ ref: 'changed', path: 'correlation' }] }] },
    withinMs: 60000,
    lifecycle: { oneShot: false, cooldownMs: 0, completeOnGoal: false },
    target: { runtime: 'ei-validation-host', kind: 'benchmark-task', id: `task-${slot}` },
  };
}

export function validateCampaign(body, config) {
  const profiles = ['smoke', 'steady', 'burst', 'fault-injected'];
  if (!body || !profiles.includes(body.profile)) throw new Error('profile must be smoke, steady, burst, or fault-injected');
  const triggerCount = body.triggerCount ?? 1000;
  const durationSeconds = body.durationSeconds ?? (body.profile === 'smoke' ? 5 : 600);
  const requestedRate = body.requestedRatePerSecond ?? 10;
  const concurrency = body.concurrency ?? 1;
  const eventCount = body.eventCount ?? Math.min(MAX_EVENTS, Math.ceil(durationSeconds * requestedRate));
  const partitions = body.partitions ?? 2;
  for (const [name, value, min, max] of [
    ['triggerCount', triggerCount, 1, MAX_TRIGGERS], ['durationSeconds', durationSeconds, 1, MAX_DURATION_SECONDS],
    ['requestedRatePerSecond', requestedRate, 1, 1000], ['concurrency', concurrency, 1, MAX_CONCURRENCY],
    ['eventCount', eventCount, 1, MAX_EVENTS], ['partitions', partitions, 2, 256],
  ]) if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  if (body.profile !== 'smoke' && durationSeconds < 600) throw new Error('SLO profiles require at least 600 seconds');
  // A 600s declaration is not a 600s workload if its configured event budget
  // runs out after only a few seconds at the requested injection rate.
  if (body.profile !== 'smoke' && eventCount < durationSeconds * requestedRate) {
    throw new Error('SLO eventCount must cover durationSeconds × requestedRatePerSecond; reduce the requested rate or duration instead of reporting idle time as load');
  }
  if (triggerCount === 100_000 && (!config.allow100k || body.allow100k !== true)) throw new Error('100k triggers require EI_ALLOW_100K=true and allow100k=true on this campaign');
  if (body.profile === 'fault-injected' && (body.injectWorkerCrash !== true || body.faultConfirmation !== 'CRASH_EI_WORKER_A' || config.faultToken.length < 32)) throw new Error('fault-injected profile requires enabled worker fault injection, EI_FAULT_TOKEN, and faultConfirmation=CRASH_EI_WORKER_A');
  if (body.profile === 'fault-injected' && body.databaseUnavailable === true) throw new Error('database interruption is disabled for this single-database setup; use an isolated HA fault-test environment');
  return { profile: body.profile, triggerCount, durationSeconds, requestedRatePerSecond: requestedRate, concurrency, eventCount, partitions, injectWorkerCrash: body.injectWorkerCrash === true };
}

/**
 * A candidate workload with incomplete event injection or <target observed
 * monotonic span must not be reported as a completed SLO campaign.
 * Coverage is distinct from matching/wake correctness and production signoff.
 */
// Exclude send starts beyond the exact requested window, including the
// unused remainder of a partial final 60-second bucket.
export function monotonicAttemptBucket(elapsedMs, durationSeconds) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= durationSeconds * 1000) return null;
  return Math.floor(elapsedMs / (LOAD_BUCKET_SECONDS * 1000));
}

/** Authenticated operator-only, bounded inventory; never project source payloads,
 * tokens, event IDs, raw errors or evidence into the campaign list.
 * Keep active campaigns visible even when many past runs exist.
 */
export function campaignInventory(campaigns) {
  const items = [...campaigns.values()];
  items.sort((left, right) => {
    const active = Number(ACTIVE_CAMPAIGN_STATES.has(right.status)) -
      Number(ACTIVE_CAMPAIGN_STATES.has(left.status));
    return active || String(right.createdAt).localeCompare(String(left.createdAt)) ||
      String(right.id).localeCompare(String(left.id));
  });
  return {
    schema: 'event-intelligence.validation-campaign-inventory.v1',
    activeCount: items.filter(item => ACTIVE_CAMPAIGN_STATES.has(item.status)).length,
    truncated: items.length > 100,
    campaigns: items.slice(0, 100).map(item => ({
      id: item.id, status: item.status, profile: item.options?.profile ?? null,
      createdAt: item.createdAt, startedAt: item.startedAt,
      completedAt: item.completedAt,
      attemptedEvents: item.attemptedEvents, acceptedEvents: item.acceptedEvents,
    })),
  };
}

export function assessCampaignWindowCoverage(options, { attemptedEvents, elapsedSeconds, attemptedMinuteBuckets, aborted = false } = {}) {
  if (options.profile === 'smoke') return Object.freeze({ covered: !aborted, missing: aborted ? ['interrupted'] : [] });
  const missing = [];
  if (aborted) missing.push('interrupted');
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < options.durationSeconds) missing.push('actual-duration-below-declared-window');
  if (!Number.isSafeInteger(attemptedEvents) || attemptedEvents < options.eventCount) missing.push('insufficient-events-attempted');

  // Aggregates do not prove sustained load: a paused sender can catch up later.
  // Record actual monotonic send attempts in minute windows, never planned times.
  const bucketCount = Math.ceil(options.durationSeconds / LOAD_BUCKET_SECONDS);
  if (!Array.isArray(attemptedMinuteBuckets) ||
      attemptedMinuteBuckets.length > bucketCount ||
      attemptedMinuteBuckets.some(count => !Number.isSafeInteger(count) || count < 0)) {
    missing.push('invalid-monotonic-load-buckets');
  } else {
    const inWindowAttempts = attemptedMinuteBuckets.reduce((sum, count) => sum + count, 0);
    if (inWindowAttempts < options.eventCount) missing.push('insufficient-in-window-attempts');
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      const seconds = Math.min(LOAD_BUCKET_SECONDS, options.durationSeconds - bucket * LOAD_BUCKET_SECONDS);
      // Harness-integrity threshold only; NOT production SLO certification.
      const minimum = Math.max(1, Math.ceil(seconds * options.requestedRatePerSecond * MIN_BUCKET_COVERAGE));
      if ((attemptedMinuteBuckets[bucket] ?? 0) < minimum) missing.push(`insufficient-minute-${bucket}-load`);
    }
  }
  return Object.freeze({ covered: missing.length === 0, missing: Object.freeze(missing) });
}

export async function waitForLaunch(launchAt, { now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), signal } = {}) {
  let delay = launchAt - now();
  while (delay > 0 && !signal?.aborted) {
    await sleep(Math.min(delay, 1000));
    delay = launchAt - now();
  }
}

export function campaignLaunchAt(profile, start, eventIndex, requestedRatePerSecond) {
  if (profile === 'burst') {
    const burstSize = Math.max(1, Math.floor(requestedRatePerSecond * 5));
    return start + Math.floor(eventIndex / burstSize) * 5000;
  }
  return start + eventIndex * (1000 / requestedRatePerSecond);
}

export function createBenchmarkService({ env = process.env, pool: suppliedPool, logger = console } = {}) {
  const config = readBenchmarkConfig(env);
  const pool = suppliedPool ?? new Pool({ connectionString: config.databaseUrl, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 15000, application_name: 'ei-benchmark', keepAlive: true });
  const campaigns = new Map();
  const campaignTable = `\"${config.tablePrefix}_campaigns\"`;
  const activeAborters = new Map();
  const campaignTasks = new Map();
  let inspectorEvidenceActive = false;
  let server;
  let ready = false;
  let postgresVersion = null;

  async function initialize() {
    const connection = await pool.query('SELECT current_setting(\'server_version\') AS server_version');
    postgresVersion = connection.rows[0].server_version;
    await pool.query(`CREATE TABLE IF NOT EXISTS ${HOST_TABLE} (scope_id TEXT NOT NULL, wake_id TEXT NOT NULL, receipt_id TEXT NOT NULL, attempt_count BIGINT NOT NULL DEFAULT 1, first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(scope_id, wake_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${campaignTable} (campaign_id UUID PRIMARY KEY, scope_id TEXT NOT NULL UNIQUE, metadata JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`);
    const stored = await pool.query(`SELECT metadata FROM ${campaignTable} ORDER BY updated_at DESC LIMIT 1000`);
    for (const row of stored.rows) {
      const metadata = row.metadata;
      if (!metadata || typeof metadata.id !== 'string' || typeof metadata.scopeId !== 'string' || !metadata.scopeId.startsWith(`${config.scopeBase}:`)) continue;
      const campaign = { ...emptyCampaign(metadata.id, metadata.scopeId, metadata.options, metadata.createdAt), ...metadata,
        verifiedWakes: new Set(), eventStarts: new Map(), rawSampleRows: [], providerToWorkerSamples: [], ingestToMatchSamples: [], matchToWakeSamples: [], hostEffectSamples: [], endToEndSamples: [], workerRequestCounts: new Map(Object.entries(metadata.workerRequestCounts || {})), errors: metadata.errors || [], faults: metadata.faults || [] };
      if (ACTIVE_CAMPAIGN_STATES.has(campaign.status)) {
        campaign.status = 'interrupted';
        campaign.error = { message: 'benchmark service restarted while this campaign was active' };
      }
      const base = join(resolve(config.artifactDir), `ei-validation-${campaign.id}`);
      try {
        const [json, checksum, raw, rawChecksum] = await Promise.all([
          readFile(`${base}.json`, 'utf8'), readFile(`${base}.sha256`, 'utf8'),
          readFile(`${base}.jsonl`, 'utf8'), readFile(`${base}.jsonl.sha256`, 'utf8'),
        ]);
        const verified = verifyCampaignArtifact(json, checksum);
        const samples = verifyRawSampleArtifact(raw, rawChecksum, verified.report?.rawSamples?.rows);
        if (verified.valid && samples.valid && verified.report.campaignId === campaign.id && verified.report.scopeId === campaign.scopeId) {
          campaign.artifactPath = `${base}.json`;
          campaign.rawArtifactPath = `${base}.jsonl`;
          campaign.artifactSha256 = verified.sha256;
          campaign.rawArtifactSha256 = samples.sha256;
          campaign.report = verified.report;
          campaign.status = campaign.status === 'cleaned' ? 'cleaned' : verified.report.status || campaign.status;
          campaign.attemptedEvents = verified.report.observed?.attemptedEvents || 0;
          campaign.acceptedEvents = verified.report.observed?.acceptedEvents || 0;
          campaign.matchedEvents = verified.report.observed?.matchedEvents || 0;
          campaign.persistedDeliveredWakes = verified.report.observed?.persistedDeliveredWakes || 0;
          campaign.duplicateHostEffects = verified.report.observed?.duplicateHostEffects || 0;
          campaign.errorCount = verified.report.observed?.errors || 0;
          campaign.verifiedWakeCount = verified.report.observed?.verifiedWakes || 0;
        }
      } catch { /* artifacts may not exist for an interrupted campaign */ }
      campaigns.set(campaign.id, campaign);
      await persistCampaign(campaign);
    }
    ready = true;
  }

  function emptyCampaign(id, scopeId, options, createdAt = new Date().toISOString()) {
    return { id, options, scopeId, status: 'queued', createdAt, startedAt: null, completedAt: null, attemptedEvents: 0, acceptedEvents: 0, matchedEvents: 0, persistedDeliveredWakes: 0, duplicateCallbackAttempts: 0, duplicateHostEffects: 0, errorCount: 0, verifiedWakes: new Set(), eventStarts: new Map(), rawSampleRows: [], providerToWorkerSamples: [], ingestToMatchSamples: [], matchToWakeSamples: [], hostEffectSamples: [], endToEndSamples: [], workerRequestCounts: new Map(), workerMetrics: null, postgresStats: null, databaseStorageGrowthBytes: null, errors: [], faults: [], attemptedMinuteBuckets: [], outOfWindowAttemptCount: 0, loadCoverage: null, artifactPath: null, artifactSha256: null, rawArtifactPath: null, rawArtifactSha256: null, report: null, elapsedSeconds: 0 };
  }

  async function persistCampaign(campaign) {
    const metadata = {
      id: campaign.id, scopeId: campaign.scopeId, options: campaign.options, status: campaign.status,
      createdAt: campaign.createdAt, startedAt: campaign.startedAt, completedAt: campaign.completedAt,
      error: campaign.error || null, report: campaign.report || null, attemptedEvents: campaign.attemptedEvents || 0,
      acceptedEvents: campaign.acceptedEvents || 0, matchedEvents: campaign.matchedEvents || 0,
      persistedDeliveredWakes: campaign.persistedDeliveredWakes || 0, duplicateHostEffects: campaign.duplicateHostEffects || 0,
      errorCount: campaign.errorCount || 0, workerRequestCounts: Object.fromEntries(campaign.workerRequestCounts || []),
      artifactSha256: campaign.artifactSha256 || null, rawArtifactSha256: campaign.rawArtifactSha256 || null,
    };
    await pool.query(`INSERT INTO ${campaignTable} (campaign_id,scope_id,metadata) VALUES ($1,$2,$3::jsonb) ON CONFLICT (campaign_id) DO UPDATE SET metadata=EXCLUDED.metadata,updated_at=clock_timestamp()`, [campaign.id, campaign.scopeId, JSON.stringify(metadata)]);
  }

  async function receiveWake(request, response) {
    if (!bearerMatches(request, config.hostCallbackToken)) return sendJson(response, 401, { error: 'unauthorized' });
    const body = await readJson(request, 64 * 1024);
    const scopeId = safeIdentifier(body?.scopeId, 'scopeId');
    const packet = body?.packet;
    if (!scopeId.startsWith(`${config.scopeBase}:`) || !packet || typeof packet.wake_id !== 'string' || !packet.target || !Array.isArray(packet.source_event_refs)) return sendJson(response, 400, { error: 'invalid-wake-packet' });
    const eventRefs = packet.source_event_refs;
    const campaign = [...campaigns.values()].find(item => item.scopeId === scopeId);
    const sample = campaign?.eventStarts.get(eventRefs.at(-1)?.event_id);
    const started = sample?.startedAt;
    const hostEffectStart = performance.now();
    const receiptId = `receipt-${createHash('sha256').update(`${scopeId}:${packet.wake_id}`).digest('hex').slice(0, 32)}`;
    const result = await pool.query(
      `INSERT INTO ${HOST_TABLE} (scope_id,wake_id,receipt_id) VALUES ($1,$2,$3) ON CONFLICT (scope_id,wake_id) DO UPDATE SET attempt_count=${HOST_TABLE}.attempt_count+1,last_seen_at=clock_timestamp() RETURNING attempt_count`,
      [scopeId, packet.wake_id, receiptId],
    );
    const duplicate = Number(result.rows[0].attempt_count) > 1;
    if (campaign && started !== undefined) {
      campaign.hostEffectSamples.push(performance.now() - hostEffectStart);
      campaign.endToEndSamples.push(performance.now() - started);
      sample.hostEffectMs = campaign.hostEffectSamples.at(-1);
      sample.providerToHostEndToEndMs = campaign.endToEndSamples.at(-1);
      sample.hostReceipt = true;
    }
    if (campaign) {
      if (duplicate) campaign.duplicateCallbackAttempts++;
      campaign.verifiedWakes.add(packet.wake_id);
    }
    campaign?.eventStarts.delete(eventRefs.at(-1)?.event_id);
    return sendJson(response, 200, { runtimeReceiptId: receiptId, duplicate, status: 'completed' });
  }

  async function requestWorker(worker, path, body, token = config.ingestToken) {
    const response = await fetch(`${worker.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message;
      throw new Error(`${worker.id} ${path} failed with HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 240)}` : ''}`);
    }
    return payload;
  }

  async function collectWorkerMetrics(scopeId) {
    const result = {};
    for (const worker of config.workers) {
      try {
        const response = await fetch(`${worker.url}/v1/metrics?scopeId=${encodeURIComponent(scopeId)}`, { headers: { authorization: `Bearer ${config.ingestToken}` }, signal: AbortSignal.timeout(3000) });
        result[worker.id] = response.ok ? await response.json() : null;
      } catch { result[worker.id] = null; }
    }
    return result;
  }

  async function waitForWakeSettlement(campaign) {
    const startedAt = performance.now();
    const deadline = startedAt + config.wakeSettleTimeoutSeconds * 1000;
    const expectedWakeCount = campaign.matchedEvents;
    let observed = { verifiedHostReceipts: 0, persistedDeliveredWakeCount: null, dueWakeBacklog: null, pendingWakeDeliveries: null, deadLetterWakeDeliveries: null };
    while (performance.now() < deadline) {
      const receiptCount = await pool.query(`SELECT count(DISTINCT wake_id)::integer AS count FROM ${HOST_TABLE} WHERE scope_id=$1`, [campaign.scopeId]);
      const workerMetrics = await collectWorkerMetrics(campaign.scopeId);
      const available = Object.values(workerMetrics).filter(value => value && Number.isSafeInteger(value.pendingWakeDeliveries));
      const due = available.length ? Math.max(...available.map(value => value.dueWakeBacklog ?? 0)) : null;
      const pending = available.length ? Math.max(...available.map(value => value.pendingWakeDeliveries)) : null;
      const deadLetters = available.length ? Math.max(...available.map(value => value.deadLetterWakeDeliveries ?? 0)) : null;
      const deliveredCounts = Object.values(workerMetrics).map(value => value?.persistedDeliveredWakeCount);
      const persistedDeliveredWakeCount = deliveredCounts.length === config.workers.length &&
        deliveredCounts.every(Number.isSafeInteger) && new Set(deliveredCounts).size === 1
        ? deliveredCounts[0] : null;
      observed = { verifiedHostReceipts: Number(receiptCount.rows[0].count), persistedDeliveredWakeCount, dueWakeBacklog: due, pendingWakeDeliveries: pending, deadLetterWakeDeliveries: deadLetters };
      if (observed.verifiedHostReceipts === expectedWakeCount && persistedDeliveredWakeCount === expectedWakeCount && due === 0 && pending === 0 && deadLetters === 0) {
        return { ...observed, expectedWakeCount, settled: true, elapsedSeconds: (performance.now() - startedAt) / 1000 };
      }
      if (pending === 0 && deadLetters !== null && deadLetters > 0 && observed.verifiedHostReceipts + deadLetters >= expectedWakeCount) {
        return { ...observed, expectedWakeCount, settled: false, elapsedSeconds: (performance.now() - startedAt) / 1000 };
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return { ...observed, expectedWakeCount, settled: false, timedOut: true, elapsedSeconds: (performance.now() - startedAt) / 1000 };
  }

  async function writeArtifacts(campaign) {
    const directory = resolve(config.artifactDir);
    await mkdir(directory, { recursive: true });
    const metrics = {
      schema: 'event-intelligence.railway-validation-campaign.v1',
      campaignId: campaign.id, profile: campaign.options.profile, scopeId: campaign.scopeId,
      status: campaign.finalStatus || campaign.status,
      startedAt: campaign.startedAt, completedAt: new Date().toISOString(),
      sourceCommitSha: env.SOURCE_COMMIT_SHA || env.RAILWAY_GIT_COMMIT_SHA || null,
      environment: { node: process.version, postgresVersion, pgDriver: 'pg 8.16.3', cpuModel: null, benchmarkRssBytes: process.memoryUsage().rss, railwayRegion: env.RAILWAY_REPLICA_REGION || null },
      trafficSource: 'synthetic MCP-shaped events generated by ei-benchmark over private HTTP',
      externalProviderMeasured: false,
      configuration: { ...campaign.options, workers: config.workers.map(({ id }) => id), partitions: campaign.options.partitions },
      observed: { elapsedSeconds: campaign.elapsedSeconds, requestedEvents: campaign.options.eventCount, attemptedEvents: campaign.attemptedEvents, attemptedMinuteBuckets: campaign.attemptedMinuteBuckets, outOfWindowAttemptCount: campaign.outOfWindowAttemptCount, loadCoverage: campaign.loadCoverage, acceptedEvents: campaign.acceptedEvents, matchedEvents: campaign.matchedEvents, persistedDeliveredWakes: campaign.persistedDeliveredWakes, verifiedWakes: campaign.verifiedWakes.size, duplicateCallbackAttempts: campaign.duplicateCallbackAttempts, duplicateHostEffects: campaign.duplicateHostEffects, errors: campaign.errorCount, lostEvents: Math.max(0, campaign.attemptedEvents - campaign.verifiedWakes.size), requestedEventRatePerSecond: campaign.options.requestedRatePerSecond, achievedRequestRatePerSecond: campaign.elapsedSeconds ? campaign.acceptedEvents / campaign.elapsedSeconds : 0, workerRequestCounts: Object.fromEntries(campaign.workerRequestCounts), workerCpuUsageMicros: campaign.workerCpuUsageMicros, backlog: campaign.workerMetrics ? Object.fromEntries(Object.entries(campaign.workerMetrics).map(([key, value]) => [key, value?.dueWakeBacklog ?? null])) : null, pendingWakeDeliveries: campaign.wakeSettlement?.pendingWakeDeliveries ?? null, wakeSettlement: campaign.wakeSettlement ?? null, queueDepth: null, workerMetrics: campaign.workerMetrics, postgresDatabaseStats: campaign.postgresStats, databaseStorageGrowthBytes: campaign.databaseStorageGrowthBytes },
      latency: { providerToWorkerResponse: percentileStatsOrMissing(campaign.providerToWorkerSamples), hostEffect: percentileStatsOrMissing(campaign.hostEffectSamples), providerToHostEndToEnd: percentileStatsOrMissing(campaign.endToEndSamples), providerToIngest: null, ingestToMatch: percentileStatsOrMissing(campaign.ingestToMatchSamples), matchToWake: percentileStatsOrMissing(campaign.matchToWakeSamples) },
      rawSamples: { file: `ei-validation-${campaign.id}.jsonl`, rows: campaign.rawSampleRows.length, maxRows: MAX_RAW_SAMPLE_ROWS, truncated: campaign.acceptedEvents > campaign.rawSampleRows.length },
      missingMetrics: [
        'providerToIngest (no clock-safe ingest acknowledgement boundary)',
        ...(campaign.ingestToMatchSamples.length ? [] : ['ingestToMatch (no valid worker timing samples)']),
        ...(campaign.matchToWakeSamples.length ? [] : ['matchToWake (no successful wake delivery timing samples)']),
        'total pending wake queue depth (campaign reports per-scope unsettled deliveries, not full service queue depth)',
        'PostgreSQL service CPU/memory attribution',
        'independent provider and host failure domains',
        ...(campaign.acceptedEvents > campaign.rawSampleRows.length ? ['raw latency sample set is truncated at 100000 rows'] : []),
      ],
      faults: campaign.faults,
      limitations: ['The provider is a synthetic MCP-shaped event generator, not a real third-party provider.', 'Provider and host HTTP roles share ei-benchmark process and Railway failure domain.', 'Host effect idempotency ledger uses the shared benchmark PostgreSQL database.', 'Cross-container wall-clock timestamps are not subtracted.', 'Database unavailability/failover fault was not executed against this single PostgreSQL service.', 'Partition movement is exercised through routing away from the failed worker; PostgreSQL HA lease failover remains unverified.', 'No WORM archive or retention purge is implemented by this campaign service.'],
      productionSloCertified: false,
    };
    const assessment = assessPostgresProductionSloEvidence({
      schema: 'event-intelligence.postgres-production-slo-evidence.v1',
      productionSloCertified: false,
      observedAt: new Date().toISOString(),
      environment: { node: process.version, postgres: postgresVersion, pgDriver: 'pg 8.16.3', cpuModel: null, memoryBytes: process.memoryUsage().rss, sourceCommitSha: env.SOURCE_COMMIT_SHA || env.RAILWAY_GIT_COMMIT_SHA || null },
      profiles: [{ name: campaign.options.profile, durationSeconds: campaign.elapsedSeconds, requestedEventRatePerSecond: campaign.options.requestedRatePerSecond, observedEventRatePerSecond: campaign.elapsedSeconds ? campaign.acceptedEvents / campaign.elapsedSeconds : 0, workers: 2, partitions: campaign.options.partitions, expectedWakes: campaign.options.eventCount, persistedDeliveredWakes: campaign.persistedDeliveredWakes, verifiedWakes: campaign.verifiedWakes.size, wakeSettlement: campaign.wakeSettlement, duplicateHostEffects: campaign.duplicateHostEffects, providerTransportMeasured: campaign.providerToWorkerSamples.length > 0, externalHostEffectMeasured: campaign.hostEffectSamples.length > 0, postgresServiceResourcesMeasured: false, latency: { providerToIngest: null, ingestToMatch: percentileStatsOrMissing(campaign.ingestToMatchSamples), matchToWake: percentileStatsOrMissing(campaign.matchToWakeSamples), hostEffect: percentileStatsOrMissing(campaign.hostEffectSamples) }, faults: campaign.faults }],
    });
    metrics.sloGate = { status: 'blocked', productionSloCertified: false, missing: assessment.missing };
    const json = JSON.stringify(metrics, null, 2) + '\n';
    const digest = createHash('sha256').update(json).digest('hex');
    const base = `ei-validation-${campaign.id}`;
    const jsonPath = join(directory, `${base}.json`);
    const tmpPath = `${jsonPath}.tmp`;
    await writeFile(tmpPath, json, { flag: 'wx', mode: 0o600 });
    await rename(tmpPath, jsonPath);
    await writeFile(join(directory, `${base}.sha256`), `${digest}  ${base}.json\n`, { flag: 'wx', mode: 0o600 });
    const rawSamples = campaign.rawSampleRows.map(row => JSON.stringify({ eventId: row.eventId, workerId: row.workerId, providerToWorkerResponseMs: row.providerToWorkerResponseMs ?? null, ingestToMatchMs: row.ingestToMatchMs ?? null, matchToWakeMs: row.matchToWakeMs ?? null, hostEffectMs: row.hostEffectMs ?? null, providerToHostEndToEndMs: row.providerToHostEndToEndMs ?? null, hostReceipt: row.hostReceipt === true })).join('\n') + (campaign.rawSampleRows.length ? '\n' : '');
    if (Buffer.byteLength(rawSamples) > MAX_ARTIFACT_BYTES) throw new Error('raw sample artifact exceeds the 32 MiB output limit');
    const rawPath = join(directory, `${base}.jsonl`);
    await writeFile(`${rawPath}.tmp`, rawSamples, { flag: 'wx', mode: 0o600 });
    await rename(`${rawPath}.tmp`, rawPath);
    const rawDigest = createHash('sha256').update(rawSamples).digest('hex');
    await writeFile(`${rawPath}.sha256`, `${rawDigest}  ${base}.jsonl\n`, { flag: 'wx', mode: 0o600 });
    campaign.artifactPath = jsonPath;
    campaign.artifactSha256 = digest;
    campaign.rawArtifactPath = rawPath;
    campaign.rawArtifactSha256 = rawDigest;
    campaign.report = metrics;
    await persistCampaign(campaign);
  }

  async function runCampaign(campaign) {
    const { options } = campaign;
    const controller = new AbortController();
    activeAborters.set(campaign.id, controller);
    campaign.status = 'preparing';
    await persistCampaign(campaign);
    const dbStart = await pool.query("SELECT pg_database_size(current_database())::bigint AS bytes, (SELECT xact_commit FROM pg_stat_database WHERE datname=current_database())::bigint AS commits");
    campaign.databaseSizeStartBytes = Number(dbStart.rows[0].bytes);
    const workerA = config.workers[0];
    const batchSize = 500;
    for (let offset = 0; offset < options.triggerCount; offset += batchSize) {
      if (controller.signal.aborted) throw new Error('campaign stopped');
      const rows = Array.from({ length: Math.min(batchSize, options.triggerCount - offset) }, (_, index) => triggerDefinition(offset + index));
      await requestWorker(workerA, '/v1/triggers/batch', { scopeId: campaign.scopeId, triggers: rows });
    }
    campaign.workerMetricsStart = await collectWorkerMetrics(campaign.scopeId);
    campaign.status = 'running';
    campaign.startedAt = new Date().toISOString();
    await persistCampaign(campaign);
    const start = performance.now();
    const due = start + options.durationSeconds * 1000;
    let index = 0;
    let workerAStopped = false;
    let crashPromise = null;
    const inFlight = new Set();
    async function sendOne(eventIndex) {
      if (controller.signal.aborted) return;
      if (options.profile === 'fault-injected' && eventIndex >= Math.floor(options.eventCount / 2)) {
        if (!crashPromise) crashPromise = (async () => {
          const confirmation = await requestWorker(workerA, '/v1/admin/crash', { confirmation: 'CRASH_THIS_WORKER:ei-worker-a' }, config.faultToken);
          if (confirmation.accepted !== true) throw new Error('worker crash injection was not acknowledged');
          workerAStopped = true;
          campaign.faults.push('worker-kill', 'partition-rebalance');
          await requestWorker(config.workers[1], '/v1/recover', { scopeId: campaign.scopeId });
        })();
        await crashPromise;
      }
      const slot = eventIndex % options.triggerCount;
      const worker = workerAStopped ? config.workers[1] : config.workers[eventIndex % config.workers.length];
      const eventId = `${campaign.id}-event-${eventIndex}`;
      const sample = { eventId, workerId: worker.id, startedAt: performance.now(), providerToWorkerResponseMs: null, ingestToMatchMs: null, matchToWakeMs: null, hostEffectMs: null, providerToHostEndToEndMs: null, hostReceipt: false };
      campaign.attemptedEvents++;
      const minute = monotonicAttemptBucket(sample.startedAt - start, options.durationSeconds);
      if (minute !== null) {
        campaign.attemptedMinuteBuckets[minute] = (campaign.attemptedMinuteBuckets[minute] ?? 0) + 1;
      } else {
        campaign.outOfWindowAttemptCount++;
      }
      campaign.eventStarts.set(eventId, sample);
      if (campaign.rawSampleRows.length < MAX_RAW_SAMPLE_ROWS) campaign.rawSampleRows.push(sample);
      const callStart = performance.now();
      const packet = { scopeId: campaign.scopeId, traceId: `${campaign.id}-trace-${eventIndex}`, serverId: 'remote-mcp-provider', event: { eventId, name: `railway.validation.changed.${slot}`, timestamp: new Date().toISOString(), data: { slot, correlation: `partition-${slot % options.partitions}`, index: eventIndex } } };
      try {
        const result = await requestWorker(worker, '/v1/events', packet);
        campaign.providerToWorkerSamples.push(performance.now() - callStart);
        sample.providerToWorkerResponseMs = campaign.providerToWorkerSamples.at(-1);
        if (Number.isFinite(result.timings?.ingestToMatchMs) && result.timings.ingestToMatchMs >= 0) {
          sample.ingestToMatchMs = result.timings.ingestToMatchMs;
          campaign.ingestToMatchSamples.push(sample.ingestToMatchMs);
        }
        const wakeTiming = Array.isArray(result.timings?.matchToWakeSamplesMs) ? result.timings.matchToWakeSamplesMs : [];
        sample.matchToWakeMs = wakeTiming.length === 1 && Number.isFinite(wakeTiming[0]) && wakeTiming[0] >= 0 ? wakeTiming[0] : null;
        for (const value of wakeTiming) if (Number.isFinite(value) && value >= 0) campaign.matchToWakeSamples.push(value);
        campaign.workerRequestCounts.set(worker.id, (campaign.workerRequestCounts.get(worker.id) || 0) + 1);
        campaign.acceptedEvents++;
        campaign.persistedDeliveredWakes += Number(result.persistedDeliveredWakes || 0);
        campaign.matchedEvents += Number(result.matched || 0);
      } catch (error) {
        campaign.errorCount++;
        if (campaign.errors.length < 100) campaign.errors.push({ worker: worker.id, message: String(error.message).slice(0, 180) });
        campaign.eventStarts.delete(eventId);
      }
    }
    while (index < options.eventCount && performance.now() < due && !controller.signal.aborted) {
      const launchAt = campaignLaunchAt(options.profile, start, index, options.requestedRatePerSecond);
      if (!controller.signal.aborted) await waitForLaunch(launchAt, { signal: controller.signal });
      if (controller.signal.aborted || performance.now() >= due) break;
      while (inFlight.size >= options.concurrency && !controller.signal.aborted) await Promise.race(inFlight);
      if (controller.signal.aborted) break;
      const eventIndex = index++;
      const task = sendOne(eventIndex).catch(error => {
        campaign.errorCount++;
        if (campaign.errors.length < 100) campaign.errors.push({ worker: 'fault-injection', message: String(error.message).slice(0, 180) });
      }).finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
    await Promise.all(inFlight);
    // A valid full-size burst naturally ends its last burst up to 5s before
    // the window boundary. Finish the announced observation window without
    // fabricating any additional injection or counting a shorter actual run.
    if (!controller.signal.aborted && options.profile !== 'smoke') {
      await waitForLaunch(due, { signal: controller.signal });
    }
    campaign.elapsedSeconds = (performance.now() - start) / 1000;
    const coverage = assessCampaignWindowCoverage(options, {
      attemptedEvents: campaign.attemptedEvents,
      elapsedSeconds: campaign.elapsedSeconds,
      attemptedMinuteBuckets: campaign.attemptedMinuteBuckets,
      aborted: controller.signal.aborted,
    });
    campaign.loadCoverage = coverage;
    if (!coverage.covered && !controller.signal.aborted) {
      campaign.errorCount++;
      campaign.errors.push({
        worker: 'workload-coverage',
        message: 'SLO workload is incomplete: ' + coverage.missing.join(', '),
      });
    }
    campaign.status = 'finalizing';
    await persistCampaign(campaign);
    campaign.wakeSettlement = await waitForWakeSettlement(campaign);
    // The ingest response only includes deliveries completed inline. Some
    // dispatches finish asynchronously, so use the shared PostgreSQL state
    // reconciled across both workers after callback settlement.
    campaign.persistedDeliveredWakes = campaign.wakeSettlement.persistedDeliveredWakeCount;
    if (!campaign.wakeSettlement.settled) {
      campaign.errorCount++;
      if (campaign.errors.length < 100) campaign.errors.push({ worker: 'wake-settlement', message: campaign.wakeSettlement.timedOut ? 'wake delivery settlement timed out' : 'final persisted wake, host receipt, backlog, or dead-letter counts did not match settlement requirements' });
    }
    campaign.finalStatus = controller.signal.aborted ? 'stopped' : (campaign.errors.length ? 'completed-with-errors' : 'completed');
    const dbEnd = await pool.query("SELECT pg_database_size(current_database())::bigint AS bytes, (SELECT xact_commit FROM pg_stat_database WHERE datname=current_database())::bigint AS commits");
    campaign.databaseSizeEndBytes = Number(dbEnd.rows[0].bytes);
    campaign.databaseStorageGrowthBytes = campaign.databaseSizeEndBytes - campaign.databaseSizeStartBytes;
    campaign.postgresStats = { databaseSizeBytes: campaign.databaseSizeEndBytes, committedTransactions: Number(dbEnd.rows[0].commits) };
    campaign.workerMetrics = await collectWorkerMetrics(campaign.scopeId);
    campaign.workerCpuUsageMicros = {};
    for (const worker of config.workers) {
      const before = campaign.workerMetricsStart?.[worker.id]?.process?.cpu;
      const after = campaign.workerMetrics?.[worker.id]?.process?.cpu;
      campaign.workerCpuUsageMicros[worker.id] = before && after
        ? { user: Math.max(0, after.user - before.user), system: Math.max(0, after.system - before.system) }
        : null;
    }
    await writeArtifacts(campaign);
    campaign.status = campaign.finalStatus;
    campaign.completedAt = new Date().toISOString();
    await persistCampaign(campaign);
    activeAborters.delete(campaign.id);
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') return sendJson(response, 200, { status: 'ok' });
      if (request.method === 'GET' && url.pathname === '/readyz') {
        if (!ready) return sendJson(response, 503, { status: 'not-ready' });
        await pool.query('SELECT 1');
        return sendJson(response, 200, { status: 'ready' });
      }
      if (request.method === 'POST' && url.pathname === '/v1/host/wake') return await receiveWake(request, response);
      if (!bearerMatches(request, config.controlToken)) return sendJson(response, 401, { error: 'unauthorized' });
      if (!ready) return sendJson(response, 503, { error: 'not-ready' });
      if (request.method === 'GET' && url.pathname === '/v1/campaigns') {
        return sendJson(response, 200, campaignInventory(campaigns));
      }
      if (request.method === 'POST' && url.pathname === '/v1/campaigns') {
        if (inspectorEvidenceActive) return sendJson(response,409,{error:'inspector-evidence-active'});
        if ([...campaigns.values()].some(campaign => ACTIVE_CAMPAIGN_STATES.has(campaign.status))) return sendJson(response, 409, { error: 'campaign-already-running' });
        if (campaigns.size >= 1000) return sendJson(response, 409, { error: 'campaign-history-capacity-reached' });
        const body = await readJson(request, 32 * 1024);
        if (inspectorEvidenceActive) return sendJson(response,409,{error:'inspector-evidence-active'});
        if ([...campaigns.values()].some(campaign => ACTIVE_CAMPAIGN_STATES.has(campaign.status))) return sendJson(response, 409, { error: 'campaign-already-running' });
        if (campaigns.size >= 1000) return sendJson(response, 409, { error: 'campaign-history-capacity-reached' });
        const options = validateCampaign(body, config);
        const id = randomUUID();
        const campaign = emptyCampaign(id, `${config.scopeBase}:${id}`, options);
        campaigns.set(id, campaign);
        try {
          await persistCampaign(campaign);
        } catch (error) {
          campaigns.delete(id);
          throw error;
        }
        const task = runCampaign(campaign).catch(async error => { campaign.finalStatus = 'failed'; campaign.status = 'finalizing'; campaign.error = safeError(error); campaign.completedAt = new Date().toISOString(); await writeArtifacts(campaign).catch(writeError => logger.error?.(JSON.stringify({ event: 'campaign_artifact_failed', ...safeError(writeError) }))); campaign.status = 'failed'; activeAborters.delete(id); await persistCampaign(campaign).catch(writeError => logger.error?.(JSON.stringify({ event: 'campaign_metadata_failed', ...safeError(writeError) }))); }).finally(() => campaignTasks.delete(id));
        campaignTasks.set(id, task);
        return sendJson(response, 202, { campaignId: id, status: campaign.status, scopeId: campaign.scopeId });
      }
      const evidenceMatch=/^\/v1\/campaigns\/([a-f0-9-]+)\/inspector-evidence$/.exec(url.pathname);
      if(evidenceMatch && request.method==='POST'){
        const campaign=campaigns.get(evidenceMatch[1]);
        if(!campaign)return sendJson(response,404,{error:'campaign-not-found'});
        if(campaign.status!=='completed'||
           inspectorEvidenceActive||
           [...campaigns.values()].some(c=>ACTIVE_CAMPAIGN_STATES.has(c.status)))
          return sendJson(response,409,{error:'inspector-evidence-requires-idle-completed-campaign'});
        if(campaign.scopeId!==config.scopeBase+':'+campaign.id)
          return sendJson(response,409,{error:'campaign-scope-invalid'});
        const body=await readJson(request,4096);
        const triggerLimit=body?.triggerLimit??5;
        const samplesPerTrigger=body?.samplesPerTrigger??5;
        // Revalidate AFTER the asynchronous body read; this is the only
        // lock acquisition point and contains no await before flag=true.
        if(campaign.status!=='completed'||inspectorEvidenceActive||
           [...campaigns.values()].some(c=>ACTIVE_CAMPAIGN_STATES.has(c.status)))
          return sendJson(response,409,{error:'inspector-evidence-campaign-race'});
        if(!Number.isSafeInteger(triggerLimit)||triggerLimit<1||
           triggerLimit>20||
           !Number.isSafeInteger(samplesPerTrigger)||samplesPerTrigger<1||
           samplesPerTrigger>10||triggerLimit*samplesPerTrigger>100)
          return sendJson(response,400,{error:'invalid-bounded-inspection-profile'});
        inspectorEvidenceActive=true;
        try{
          const report=await measureRailwayInspector({
            pool,tablePrefix:config.tablePrefix,scopeId:campaign.scopeId,
            triggerCount:campaign.options.triggerCount,
            triggerLimit,samplesPerTrigger,
          });
          report.campaignId=campaign.id;
          report.campaignArtifactSha256=campaign.artifactSha256;
          const json=JSON.stringify(report,null,2)+'\n';
          const checksum=createHash('sha256').update(json).digest('hex');
          await mkdir(config.artifactDir,{recursive:true});
          const filename='inspector-'+campaign.id+'-'+randomUUID()+'.json';
          await writeFile(join(config.artifactDir,filename),json,
            {encoding:'utf8',flag:'wx'});
          logger.info?.(JSON.stringify({
            event:'ei_railway_inspector_evidence',campaignId:campaign.id,
            contract:report.contract,samples:report.samples,
            successes:report.successes,p95Ms:report.elapsedMs.p95,
            p99Ms:report.elapsedMs.p99,artifactSha256:checksum,
          }));
          return sendJson(response,200,{...report,artifactSha256:checksum,
            artifactFile:filename});
        }finally{inspectorEvidenceActive=false;}
      }
      const match = /^\/v1\/campaigns\/([a-f0-9-]+)(?:\/(stop))?$/.exec(url.pathname);
      if (match && request.method === 'GET' && !match[2]) {
        const campaign = campaigns.get(match[1]);
        if (!campaign) return sendJson(response, 404, { error: 'campaign-not-found' });
        const { id, status, scopeId, options, createdAt, startedAt, completedAt, artifactPath, artifactSha256, rawArtifactPath, rawArtifactSha256, report, error } = campaign;
        return sendJson(response, 200, { id, status, scopeId, options, createdAt, startedAt, completedAt, artifactPath, artifactSha256, rawArtifactPath, rawArtifactSha256, observed: { attemptedEvents: campaign.attemptedEvents, acceptedEvents: campaign.acceptedEvents, matchedEvents: campaign.matchedEvents, persistedDeliveredWakes: campaign.persistedDeliveredWakes, verifiedWakes: campaign.verifiedWakeCount ?? campaign.verifiedWakes.size, duplicateHostEffects: campaign.duplicateHostEffects, errors: campaign.errorCount }, ...(report ? { report } : {}), ...(error ? { error } : {}) });
      }
      if (match && request.method === 'POST' && match[2]) {
        const campaign = campaigns.get(match[1]);
        if (!campaign) return sendJson(response, 404, { error: 'campaign-not-found' });
        if (campaign.status === 'finalizing') return sendJson(response, 409, { error: 'campaign-is-finalizing' });
        const controller = activeAborters.get(campaign.id);
        controller?.abort();
        return sendJson(response, 202, { campaignId: campaign.id, status: 'stop-requested' });
      }
      const cleanupMatch = /^\/v1\/campaigns\/([a-f0-9-]+)\/cleanup$/.exec(url.pathname);
      if (cleanupMatch && request.method === 'POST') {
        if(inspectorEvidenceActive) return sendJson(response,409,{error:'inspector-evidence-active'});
        const campaign = campaigns.get(cleanupMatch[1]);
        if (!campaign) return sendJson(response, 404, { error: 'campaign-not-found' });
        if (ACTIVE_CAMPAIGN_STATES.has(campaign.status)) return sendJson(response, 409, { error: 'campaign-is-active' });
        if (campaign.status === 'cleaned') return sendJson(response, 409, { error: 'campaign-already-cleaned' });
        const body = await readJson(request, 4096);
        if(inspectorEvidenceActive) return sendJson(response,409,{error:'inspector-evidence-active'});
        if (body.confirmation !== `DELETE_ONLY_CAMPAIGN:${campaign.id}`) return sendJson(response, 400, { error: 'explicit campaign cleanup confirmation required' });
        const interruptedWithoutArtifacts = campaign.status === 'interrupted' && !campaign.artifactPath && !campaign.rawArtifactPath;
        if (campaign.scopeId !== `${config.scopeBase}:${campaign.id}`) return sendJson(response, 409, { error: 'campaign scope does not match its generated identifier; data retained' });
        if (!interruptedWithoutArtifacts) {
          if (!campaign.artifactPath || !campaign.rawArtifactPath) return sendJson(response, 409, { error: 'verified campaign artifacts are required before cleanup' });
          const artifactText = await readFile(campaign.artifactPath, 'utf8');
          const artifactChecksum = await readFile(`${campaign.artifactPath.replace(/\.json$/, '')}.sha256`, 'utf8');
          const artifact = verifyCampaignArtifact(artifactText, artifactChecksum);
          const samplesText = await readFile(campaign.rawArtifactPath, 'utf8');
          const samplesChecksum = await readFile(`${campaign.rawArtifactPath}.sha256`, 'utf8');
          const samples = verifyRawSampleArtifact(samplesText, samplesChecksum, artifact.report?.rawSamples?.rows);
          if (!artifact.valid || !samples.valid || artifact.report.campaignId !== campaign.id || artifact.report.scopeId !== campaign.scopeId) return sendJson(response, 409, { error: 'campaign artifact verification failed; data retained' });
        }
        const client = await pool.connect();
        let deleted = {};
        try {
          for (const worker of config.workers) await requestWorker(worker, `/v1/scopes/${encodeURIComponent(campaign.id)}/close`, {});
          await client.query('BEGIN');
          for (const [table, column] of [[`${config.tablePrefix}_records`, 'scope_id'], [`${config.tablePrefix}_history`, 'scope_id'], [`${config.tablePrefix}_leases`, 'scope_id'], [`${config.tablePrefix}_counters`, 'scope_id'], [HOST_TABLE, 'scope_id']]) {
            const result = await client.query(`DELETE FROM "${table}" WHERE "${column}" = $1`, [campaign.scopeId]);
            deleted[table] = result.rowCount;
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally { client.release(); }
        campaign.status = 'cleaned';
        campaign.cleanupDeletedRows = deleted;
        await persistCampaign(campaign);
        return sendJson(response, 200, { campaignId: campaign.id, status: campaign.status, deletedRows: deleted, artifactsRetained: !interruptedWithoutArtifacts, cleanupBasis: interruptedWithoutArtifacts ? 'interrupted-campaign-explicit-confirmation' : 'verified-artifacts' });
      }
      return sendJson(response, 404, { error: 'not-found' });
    } catch (error) {
      const status = Number(error?.statusCode) || (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? 500 : 400);
      return sendJson(response, status, { error: safeError(error) });
    }
  }

  return {
    config,
    async listen() { await initialize(); server = http.createServer(handle); await listenValidationPrivateServer(server, config.port); return server; },
    async close() { for (const controller of activeAborters.values()) controller.abort(); if (server) await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...campaignTasks.values()]); await pool.end(); ready = false; },
    handle,
    campaigns,
  };
}

function percentileStatsOrMissing(values) { return values.length ? percentileStats(values) : null; }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let service;
  try {
    service = createBenchmarkService();
    await service.listen();
    console.log(JSON.stringify({ event: 'validation_benchmark_ready', port: service.config.port }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'validation_benchmark_start_failed', ...safeError(error) }));
    await service?.close().catch(() => {});
    process.exitCode = 1;
  }
  const stop = async () => { await service?.close().catch(error => console.error(JSON.stringify({ event: 'validation_benchmark_shutdown_failed', ...safeError(error) }))); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
