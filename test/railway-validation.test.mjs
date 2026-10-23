import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { assessPostgresProductionSloEvidence } from '../scripts/evidence/postgres-production-slo-gate.mjs';
import { percentileStats, parsePrivateServiceUrl } from '../scripts/validation/common.mjs';
import { verifyCampaignArtifact, verifyRawSampleArtifact } from '../scripts/validation/artifact.mjs';
import { readWorkerConfig } from '../scripts/validation/worker-service.mjs';
import { campaignLaunchAt, readBenchmarkConfig, validateCampaign, waitForLaunch } from '../scripts/validation/benchmark-service.mjs';
import { buildStartPayload } from '../scripts/validation/campaign-cli.mjs';

test('validation config fails closed and permits only explicitly enabled local test URLs', () => {
  assert.throws(() => readWorkerConfig({}), /EI_WORKER_ID is required/);
  assert.throws(() => readBenchmarkConfig({}), /DATABASE_URL is required/);
  assert.throws(() => parsePrivateServiceUrl('http://example.com', 'URL'), /private HTTP networking/);
  assert.throws(() => parsePrivateServiceUrl('http://127.0.0.1:1234', 'URL'), /private HTTP networking/);
  assert.equal(parsePrivateServiceUrl('http://127.0.0.1:1234', 'URL', { allowLocal: true }), 'http://127.0.0.1:1234');
  const common = 'x'.repeat(40);
  assert.throws(() => readWorkerConfig({ EI_WORKER_ID: 'a', EI_SCOPE_ID: 'scope', DATABASE_URL: 'postgresql://localhost/db', EI_INGEST_TOKEN: common, EI_HOST_CALLBACK_TOKEN: common, EI_BENCHMARK_URL: 'http://host.railway.internal', EI_VALIDATION_ALLOW_LOCAL_HTTP: 'true' }), /must be distinct/);
  assert.throws(() => readBenchmarkConfig({ DATABASE_URL: 'postgresql://localhost/db', EI_CONTROL_TOKEN: common, EI_INGEST_TOKEN: common, EI_HOST_CALLBACK_TOKEN: common, EI_SCOPE_ID: 'scope', EI_WORKER_A_URL: 'http://a.railway.internal', EI_WORKER_B_URL: 'http://b.railway.internal' }), /must be distinct/);
});

test('campaign limits require long SLO profiles, explicit 100k opt-in, and fault confirmation', () => {
  assert.throws(() => validateCampaign({ profile: 'steady', durationSeconds: 599 }, { allow100k: true }), /at least 600 seconds/);
  assert.throws(() => validateCampaign({ profile: 'smoke', triggerCount: 100_000 }, { allow100k: false }), /100k triggers require/);
  assert.equal(validateCampaign({ profile: 'smoke', triggerCount: 100_000, allow100k: true }, { allow100k: true }).triggerCount, 100_000);
  const config = { allow100k: false, faultToken: 'f'.repeat(32) };
  assert.throws(() => validateCampaign({ profile: 'fault-injected', durationSeconds: 600 }, config), /faultConfirmation/);
  assert.throws(() => validateCampaign({ profile: 'fault-injected', durationSeconds: 600, injectWorkerCrash: true, faultConfirmation: 'CRASH_EI_WORKER_A', databaseUnavailable: true }, config), /single-database/);
});

test('latency aggregation computes nearest-rank p50/p95/p99 and rejects invalid samples', () => {
  const values = Array.from({ length: 1000 }, (_, index) => index + 1);
  assert.deepEqual(percentileStats(values), { samples: 1000, p50Ms: 500, p95Ms: 950, p99Ms: 990, maxMs: 1000 });
  assert.throws(() => percentileStats([]), /non-empty/);
  assert.throws(() => percentileStats([1, Number.NaN]), /finite/);
});

test('burst launch waits through every capped sleep until the scheduled boundary', async () => {
  let clock = 0;
  const sleeps = [];
  await waitForLaunch(4500, { now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } });
  assert.deepEqual(sleeps, [1000, 1000, 1000, 1000, 500]);
  assert.equal(clock, 4500);
});

test('steady schedules each request and burst schedules five-second groups', () => {
  assert.deepEqual([0, 1, 2, 3].map(index => campaignLaunchAt('steady', 100, index, 20)), [100, 150, 200, 250]);
  assert.deepEqual([0, 1, 2, 99, 100].map(index => campaignLaunchAt('burst', 100, index, 20)), [100, 100, 100, 100, 5100]);
});

test('CLI keeps a small smoke default and honors explicit persistent trigger scale', () => {
  assert.equal(buildStartPayload('smoke', {}).triggerCount, 10);
  assert.equal(buildStartPayload('smoke', { EI_TRIGGER_COUNT: '10000', EI_EVENT_COUNT: '12' }).triggerCount, 10_000);
  assert.equal(buildStartPayload('smoke', { EI_TRIGGER_COUNT: '10000', EI_EVENT_COUNT: '12' }).eventCount, 12);
  assert.equal(buildStartPayload('steady', { EI_TRIGGER_COUNT: '100000', EI_ALLOW_100K_RUN: 'true' }).allow100k, true);
});

test('artifact checksum rejects tampering and incomplete SLO evidence stays blocked', () => {
  const report = { schema: 'event-intelligence.railway-validation-campaign.v1', campaignId: 'test', productionSloCertified: false, missingMetrics: ['providerToIngest'], sloGate: { status: 'blocked' } };
  const text = JSON.stringify(report, null, 2) + '\n';
  const digest = createHash('sha256').update(text).digest('hex');
  const checksum = `${digest}  ei-validation-test.json\n`;
  assert.equal(verifyCampaignArtifact(text, checksum).valid, true);
  assert.equal(verifyCampaignArtifact(text.replace('test', 'tampered'), checksum).reason, 'checksum-mismatch');
  const raw = '{"eventId":"event-1","workerId":"ei-worker-a","providerToWorkerResponseMs":1,"hostEffectMs":2,"providerToHostEndToEndMs":3,"hostReceipt":true}\n';
  const rawHash = createHash('sha256').update(raw).digest('hex');
  assert.equal(verifyRawSampleArtifact(raw, `${rawHash}  ei-validation-test.jsonl\n`, 1).valid, true);
  assert.equal(verifyRawSampleArtifact(raw, `${'0'.repeat(64)}  ei-validation-test.jsonl\n`, 1).reason, 'checksum-mismatch');
  assert.equal(assessPostgresProductionSloEvidence({}).status, 'blocked');
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitReady(url, child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`service exited before ready (${child.exitCode})`);
    try {
      const response = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('service readiness timed out');
}

const databaseUrl = process.env.EI_VALIDATION_TEST_DATABASE_URL;
test('PostgreSQL 16 HTTP smoke uses two OS workers, real CEP, remote wake receipt, and restart recovery', { skip: !databaseUrl && 'set EI_VALIDATION_TEST_DATABASE_URL to a disposable PostgreSQL 16 database' }, async t => {
  const token = `test-ingest-${randomUUID()}-${randomUUID()}`;
  const hostToken = `test-host-${randomUUID()}-${randomUUID()}`;
  const controlToken = `test-control-${randomUUID()}-${randomUUID()}`;
  const prefix = `eit_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const scopeBase = `railway-test-${randomUUID()}`;
  const artifactDir = await mkdtemp(join(tmpdir(), 'ei-railway-validation-'));
  const [workerAPort, workerBPort, benchmarkPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const services = new Map();
  function spawnService(script, port, extra = {}) {
    const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(port), EI_SCOPE_ID: scopeBase, EI_TABLE_PREFIX: prefix, EI_PG_POOL_MAX: '4', EI_INGEST_TOKEN: token, EI_HOST_CALLBACK_TOKEN: hostToken, EI_VALIDATION_ALLOW_LOCAL_HTTP: 'true', EI_ARTIFACT_DIR: artifactDir, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    return child;
  }
  const workerAUrl = `http://127.0.0.1:${workerAPort}`;
  const workerBUrl = `http://127.0.0.1:${workerBPort}`;
  const benchmarkUrl = `http://127.0.0.1:${benchmarkPort}`;
  const workerA = spawnService('scripts/validation/worker-service.mjs', workerAPort, { EI_WORKER_ID: 'ei-worker-a', EI_BENCHMARK_URL: benchmarkUrl });
  const workerB = spawnService('scripts/validation/worker-service.mjs', workerBPort, { EI_WORKER_ID: 'ei-worker-b', EI_BENCHMARK_URL: benchmarkUrl });
  services.set('a', workerA); services.set('b', workerB);
  let benchmark = spawnService('scripts/validation/benchmark-service.mjs', benchmarkPort, { EI_CONTROL_TOKEN: controlToken, EI_WORKER_A_URL: workerAUrl, EI_WORKER_B_URL: workerBUrl });
  services.set('benchmark', benchmark);
  t.after(async () => {
    for (const child of services.values()) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.all([...services.values()].map(child => child.exitCode !== null ? Promise.resolve() : once(child, 'exit').catch(() => {})));
    await rm(artifactDir, { recursive: true, force: true });
  });
  await Promise.all([waitReady(workerAUrl, workerA), waitReady(workerBUrl, workerB), waitReady(benchmarkUrl, benchmark)]);

  const unauthorized = await fetch(`${workerAUrl}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauthorized.status, 401);
  const noPublicHostAuth = await fetch(`${benchmarkUrl}/v1/host/wake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noPublicHostAuth.status, 401);

  const campaignResponse = await fetch(`${benchmarkUrl}/v1/campaigns`, { method: 'POST', headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'smoke', triggerCount: 4, eventCount: 4, durationSeconds: 3, requestedRatePerSecond: 10, partitions: 2 }) });
  assert.equal(campaignResponse.status, 202);
  const { campaignId } = await campaignResponse.json();
  const deadline = Date.now() + 25000;
  let status;
  do {
    await new Promise(resolve => setTimeout(resolve, 200));
    const response = await fetch(`${benchmarkUrl}/v1/campaigns/${campaignId}`, { headers: { authorization: `Bearer ${controlToken}` } });
    status = await response.json();
  } while (!['completed', 'completed-with-errors', 'failed', 'stopped'].includes(status.status) && Date.now() < deadline);
  assert.equal(status.status, 'completed', JSON.stringify(status.error || status.observed));
  assert.equal(status.observed.acceptedEvents, 4);
  assert.equal(status.observed.persistedDeliveredWakes, 4);
  assert.equal(status.observed.verifiedWakes, 4);
  assert.equal(status.report.observed.wakeSettlement.settled, true);
  assert.equal(status.report.observed.pendingWakeDeliveries, 0);
  assert.deepEqual(Object.keys(status.report.observed.workerRequestCounts).sort(), ['ei-worker-a', 'ei-worker-b']);
  assert.equal(status.report.productionSloCertified, false);
  assert.equal(status.report.externalProviderMeasured, false);
  assert.match(status.report.trafficSource, /synthetic MCP-shaped/);
  assert.ok(status.report.latency.providerToWorkerResponse.samples === 4);
  assert.ok(status.report.missingMetrics.includes('ingestToMatch (not instrumented inside EI)'));

  const duplicatePacket = { scopeId: status.scopeId, packet: { wake_id: 'same-wake-id', target: { runtime: 'ei-validation-host', kind: 'task', id: 'x' }, source_event_refs: [] } };
  async function hostCall() {
    return fetch(`${benchmarkUrl}/v1/host/wake`, { method: 'POST', headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' }, body: JSON.stringify(duplicatePacket) });
  }
  const firstReceipt = await (await hostCall()).json();
  const secondReceipt = await (await hostCall()).json();
  assert.equal(firstReceipt.runtimeReceiptId, secondReceipt.runtimeReceiptId);
  assert.equal(firstReceipt.duplicate, false);
  assert.equal(secondReceipt.duplicate, true);
  assert.ok(!JSON.stringify(status).includes(token));

  benchmark.kill('SIGTERM');
  await once(benchmark, 'exit');
  benchmark = spawnService('scripts/validation/benchmark-service.mjs', benchmarkPort, { EI_CONTROL_TOKEN: controlToken, EI_WORKER_A_URL: workerAUrl, EI_WORKER_B_URL: workerBUrl });
  services.set('benchmark', benchmark);
  await waitReady(benchmarkUrl, benchmark);
  const restored = await fetch(`${benchmarkUrl}/v1/campaigns/${campaignId}`, { headers: { authorization: `Bearer ${controlToken}` } });
  assert.equal(restored.status, 200);
  const restoredStatus = await restored.json();
  assert.equal(restoredStatus.status, 'completed');
  assert.equal(restoredStatus.observed.acceptedEvents, 4);
  assert.equal(restoredStatus.report.campaignId, campaignId);

  workerB.kill('SIGTERM');
  await once(workerB, 'exit');
  const restarted = spawnService('scripts/validation/worker-service.mjs', workerBPort, { EI_WORKER_ID: 'ei-worker-b', EI_BENCHMARK_URL: benchmarkUrl });
  services.set('b', restarted);
  await waitReady(workerBUrl, restarted);
  const recover = await fetch(`${workerBUrl}/v1/recover`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ scopeId: status.scopeId }) });
  assert.equal(recover.status, 200);
  const invalidCleanup = await fetch(`${benchmarkUrl}/v1/campaigns/${campaignId}/cleanup`, { method: 'POST', headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: 'DELETE_ALL' }) });
  assert.equal(invalidCleanup.status, 400);
  const cleanup = await fetch(`${benchmarkUrl}/v1/campaigns/${campaignId}/cleanup`, { method: 'POST', headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: `DELETE_ONLY_CAMPAIGN:${campaignId}` }) });
  assert.equal(cleanup.status, 200);
  const cleanupSummary = await cleanup.json();
  assert.equal(cleanupSummary.status, 'cleaned');
  assert.ok(cleanupSummary.deletedRows[`${prefix}_records`] > 0);
  assert.equal(cleanupSummary.artifactsRetained, true);
  const restoredCleaned = await fetch(`${benchmarkUrl}/v1/campaigns/${campaignId}`, { headers: { authorization: `Bearer ${controlToken}` } });
  assert.equal((await restoredCleaned.json()).status, 'cleaned');
});
