#!/usr/bin/env node
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';
import { CompositeTriggerEngine } from '../../dist/src/composite/engine.js';
import { CompositeEventConsumer } from '../lib/composite-event-consumer.mjs';
import { CompositeWakeCoordinator } from '../lib/composite-wake-coordinator.mjs';
import { PostgresEventStore } from '../lib/postgres-event-store.mjs';
import { WakeRetryScheduler } from '../lib/wake-retry-scheduler.mjs';
import { bearerMatches, httpPort, parsePrivateServiceUrl, readJson, requiredEnv, safeError, safeIdentifier, sendJson } from './common.mjs';

const { Pool } = pg;

export function readWorkerConfig(env = process.env) {
  const workerId = safeIdentifier(requiredEnv(env, 'EI_WORKER_ID'), 'EI_WORKER_ID');
  const scopeBase = safeIdentifier(requiredEnv(env, 'EI_SCOPE_ID'), 'EI_SCOPE_ID');
  const tablePrefix = safeIdentifier(env.EI_TABLE_PREFIX || 'ei_validation', 'EI_TABLE_PREFIX');
  const databaseUrl = requiredEnv(env, 'DATABASE_URL', { minLength: 12 });
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  const ingestToken = requiredEnv(env, 'EI_INGEST_TOKEN', { minLength: 32 });
  const hostCallbackToken = requiredEnv(env, 'EI_HOST_CALLBACK_TOKEN', { minLength: 32 });
  if (ingestToken === hostCallbackToken) throw new Error('EI_INGEST_TOKEN and EI_HOST_CALLBACK_TOKEN must be distinct');
  const benchmarkUrl = parsePrivateServiceUrl(requiredEnv(env, 'EI_BENCHMARK_URL'), 'EI_BENCHMARK_URL', { allowLocal: env.EI_VALIDATION_ALLOW_LOCAL_HTTP === 'true' });
  const port = httpPort(env);
  const poolMax = Number(env.EI_PG_POOL_MAX || 10);
  if (!Number.isSafeInteger(poolMax) || poolMax < 2 || poolMax > 30) throw new Error('EI_PG_POOL_MAX must be an integer from 2 to 30');
  const recoveryMaxScopes = Number(env.EI_RECOVERY_MAX_SCOPES || 1000);
  if (!Number.isSafeInteger(recoveryMaxScopes) || recoveryMaxScopes < 1 || recoveryMaxScopes > 10000) throw new Error('EI_RECOVERY_MAX_SCOPES must be an integer from 1 to 10000');
  const faultToken = env.EI_FAULT_TOKEN || '';
  if (faultToken && faultToken.length < 32) throw new Error('EI_FAULT_TOKEN must have at least 32 characters');
  if (faultToken && [ingestToken, hostCallbackToken].includes(faultToken)) throw new Error('EI_FAULT_TOKEN must be distinct from service authentication tokens');
  return { workerId, scopeBase, tablePrefix, databaseUrl, ingestToken, hostCallbackToken, benchmarkUrl, port, poolMax,
    recoveryMaxScopes,
    faultEnabled: env.EI_ENABLE_WORKER_CRASH_INJECTION === 'true',
    faultToken };
}

export function createWorkerService({ env = process.env, pool: suppliedPool, logger = console } = {}) {
  const config = readWorkerConfig(env);
  const pool = suppliedPool ?? new Pool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    application_name: config.workerId,
    keepAlive: true,
  });
  const rootStore = new PostgresEventStore({
    pool, scopeId: config.scopeBase, tablePrefix: config.tablePrefix,
    ownsPool: false, dispatchPoolMax: config.poolMax,
    dispatchPoolIdentity: pool,
  });
  const scopes = new Map();
  const counters = { requests: 0, events: 0, matched: 0, delivered: 0, errors: 0, retries: 0 };
  let ready = false;
  let server;

  async function context(scopeId) {
    safeIdentifier(scopeId, 'scopeId');
    if (scopeId !== config.scopeBase && !scopeId.startsWith(`${config.scopeBase}:`)) {
      const error = new Error('scopeId must belong to this validation namespace');
      error.statusCode = 403;
      throw error;
    }
    if (scopes.has(scopeId)) return scopes.get(scopeId);
    const store = await rootStore.forScope(scopeId);
    const engine = new CompositeTriggerEngine(store, null, () => new Date(), { workerId: config.workerId, partitionLeaseMs: 30000 });
    const deliverer = async packet => {
      const response = await fetch(`${config.benchmarkUrl}/v1/host/wake`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.hostCallbackToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ scopeId, packet }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`host callback HTTP ${response.status}`);
      const receipt = await response.json();
      if (typeof receipt.runtimeReceiptId !== 'string' || !receipt.runtimeReceiptId) throw new Error('host callback returned an invalid receipt');
      return { runtimeReceiptId: receipt.runtimeReceiptId, duplicate: receipt.duplicate === true, status: receipt.status ?? 'completed' };
    };
    const coordinator = new CompositeWakeCoordinator({ store, triggerEngine: engine, deliverer, workerId: config.workerId, leaseMs: 15000, maxAttempts: 10 });
    const consumer = new CompositeEventConsumer({ store, triggerEngine: engine, wakeCoordinator: coordinator });
    const scheduler = new WakeRetryScheduler({ store, resolveCoordinator: () => coordinator, intervalMs: 1000 });
    const value = { store, engine, consumer, coordinator, scheduler };
    scopes.set(scopeId, value);
    await scheduler.runDue();
    scheduler.start();
    return value;
  }

  async function initialize() {
    await pool.query('SELECT 1');
    await rootStore.init();
    const knownScopes = (await rootStore.listScopeIds()).filter(scopeId => scopeId.startsWith(`${config.scopeBase}:`));
    if (knownScopes.length > config.recoveryMaxScopes) throw new Error(`validation recovery found ${knownScopes.length} scopes; limit is ${config.recoveryMaxScopes}`);
    for (const scopeId of knownScopes) await context(scopeId);
    ready = true;
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') return sendJson(response, 200, { status: 'ok' });
      if (request.method === 'GET' && url.pathname === '/readyz') {
        if (!ready) return sendJson(response, 503, { status: 'not-ready' });
        await pool.query('SELECT 1');
        return sendJson(response, 200, { status: 'ready', workerId: config.workerId });
      }
      if (request.method === 'POST' && url.pathname === '/v1/admin/crash') {
        if (!config.faultEnabled || !config.faultToken || !bearerMatches(request, config.faultToken)) return sendJson(response, 404, { error: 'not-found' });
        const body = await readJson(request, 4096);
        if (body.confirmation !== `CRASH_THIS_WORKER:${config.workerId}`) return sendJson(response, 400, { error: 'explicit worker confirmation required' });
        sendJson(response, 202, { accepted: true, workerId: config.workerId });
        setTimeout(() => process.exit(137), 100).unref();
        return;
      }
      if (!bearerMatches(request, config.ingestToken)) return sendJson(response, 401, { error: 'unauthorized' });
      if (!ready) return sendJson(response, 503, { error: 'not-ready' });
      if (request.method === 'POST' && url.pathname === '/v1/triggers/batch') {
        const body = await readJson(request, 2 * 1024 * 1024);
        if (!Array.isArray(body.triggers) || body.triggers.length < 1 || body.triggers.length > 500) return sendJson(response, 400, { error: 'triggers must contain 1 to 500 definitions' });
        const ctx = await context(body.scopeId);
        let inserted = 0;
        for (const definition of body.triggers) { await ctx.store.putTrigger(definition); inserted++; }
        return sendJson(response, 201, { inserted, scopeId: body.scopeId, workerId: config.workerId });
      }
      if (request.method === 'POST' && url.pathname === '/v1/events') {
        const body = await readJson(request, 256 * 1024);
        if (!body || typeof body.scopeId !== 'string' || typeof body.traceId !== 'string' || !body.traceId || !body.event || typeof body.event !== 'object') return sendJson(response, 400, { error: 'scopeId, traceId, and event are required' });
        const ctx = await context(body.scopeId);
        const start = performance.now();
        const result = await ctx.consumer.ingestMcpOccurrence({ event: body.event, serverId: body.serverId || 'railway-benchmark-provider', provider: 'railway-benchmark', traceId: body.traceId, subscriptionArguments: body.subscriptionArguments || {} });
        const elapsedMs = performance.now() - start;
        const matches = result.results.filter(row => row.matched).length;
        const delivered = result.deliveries.filter(row => row.status === 'wake_delivered').length;
        counters.requests++; counters.events++; counters.matched += matches; counters.delivered += delivered;
        return sendJson(response, 200, { accepted: true, workerId: config.workerId, elapsedMs, matched: matches, persistedDeliveredWakes: delivered, deliveries: result.deliveries });
      }
      if (request.method === 'POST' && url.pathname === '/v1/recover') {
        const body = await readJson(request, 16 * 1024);
        const ctx = await context(body.scopeId);
        const outcomes = await ctx.scheduler.runDue();
        return sendJson(response, 200, { recovered: outcomes.length, outcomes: outcomes.slice(0, 100), workerId: config.workerId });
      }
      const closeScopeMatch = /^\/v1\/scopes\/([a-f0-9-]+)\/close$/.exec(url.pathname);
      if (request.method === 'POST' && closeScopeMatch) {
        const scopeId = `${config.scopeBase}:${closeScopeMatch[1]}`;
        const ctx = scopes.get(scopeId);
        if (ctx) {
          await ctx.scheduler.close();
          scopes.delete(scopeId);
        }
        return sendJson(response, 200, { closed: true, workerId: config.workerId });
      }
      if (request.method === 'GET' && url.pathname === '/v1/metrics') {
        let backlog = null;
        let pendingWakeDeliveries = null;
        let deadLetterWakeDeliveries = null;
        const scopeId = url.searchParams.get('scopeId');
        if (scopeId) {
          const store = (await context(scopeId)).store;
          const wakeStates = await store.countWakeDeliveryStates();
          backlog = wakeStates.due;
          pendingWakeDeliveries = wakeStates.pending;
          deadLetterWakeDeliveries = wakeStates.deadLetter;
        }
        return sendJson(response, 200, { workerId: config.workerId, counters: { ...counters }, process: { uptimeSeconds: process.uptime(), rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed, cpu: process.cpuUsage() }, database: { connected: ready }, ...(backlog === null ? {} : { dueWakeBacklog: backlog }), ...(pendingWakeDeliveries === null ? {} : { pendingWakeDeliveries, deadLetterWakeDeliveries }) });
      }
      return sendJson(response, 404, { error: 'not-found' });
    } catch (error) {
      counters.errors++;
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      if (status >= 500) logger.error?.(JSON.stringify({ event: 'validation_worker_request_failed', ...safeError(error) }));
      return sendJson(response, status, { error: safeError(error) });
    }
  }

  return {
    config,
    async listen() { await initialize(); server = http.createServer(handle); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '0.0.0.0', resolve); }); return server; },
    async close() { if (server) await new Promise(resolve => server.close(resolve)); for (const ctx of scopes.values()) await ctx.scheduler.close(); await pool.end(); ready = false; },
    handle,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let service;
  try {
    service = createWorkerService();
    await service.listen();
    console.log(JSON.stringify({ event: 'validation_worker_ready', workerId: service.config.workerId, port: service.config.port }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'validation_worker_start_failed', ...safeError(error) }));
    await service?.close().catch(() => {});
    process.exitCode = 1;
  }
  const stop = async () => { await service?.close().catch(error => console.error(JSON.stringify({ event: 'validation_worker_shutdown_failed', ...safeError(error) }))); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
