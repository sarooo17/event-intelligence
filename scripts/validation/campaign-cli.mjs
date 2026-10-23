#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyCampaignArtifact, verifyRawSampleArtifact } from './artifact.mjs';

export function buildStartPayload(profile, env = process.env) {
  const triggerCount = Number(env.EI_TRIGGER_COUNT || (profile === 'smoke' ? 10 : 1000));
  const smoke = profile === 'smoke';
  return {
    profile,
    triggerCount,
    eventCount: Number(env.EI_EVENT_COUNT || (smoke ? 10 : 6000)),
    requestedRatePerSecond: Number(env.EI_REQUESTED_RATE || (smoke ? 10 : 10)),
    durationSeconds: Number(env.EI_DURATION_SECONDS || (smoke ? 5 : 600)),
    concurrency: Number(env.EI_CONCURRENCY || 1),
    partitions: Number(env.EI_PARTITIONS || 2),
    ...(triggerCount === 100_000 && env.EI_ALLOW_100K_RUN === 'true' ? { allow100k: true } : {}),
    ...(profile === 'fault-injected' && env.EI_FAULT_CONFIRMATION ? { injectWorkerCrash: true, faultConfirmation: env.EI_FAULT_CONFIRMATION } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
const [action, value] = process.argv.slice(2);
const base = process.env.EI_BENCHMARK_URL;
const token = process.env.EI_CONTROL_TOKEN;
if (action !== 'verify-artifact') {
  if (!base || !token) throw new Error('EI_BENCHMARK_URL and EI_CONTROL_TOKEN are required');
  const privateUrl = /^http:\/\/[a-z0-9.-]+\.railway\.internal(?::\d+)?$/i.test(base);
  const forwardedLocalUrl = process.env.EI_VALIDATION_ALLOW_LOCAL_HTTP === 'true' && /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/i.test(base);
  if (!privateUrl && !forwardedLocalUrl) throw new Error('EI_BENCHMARK_URL must be a Railway private URL (or an explicitly enabled localhost SSH forward)');
}
async function call(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Benchmark service returned HTTP ${response.status}: ${JSON.stringify(result)}`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (action === 'start') {
  const profile = value || 'smoke';
  await call('/v1/campaigns', 'POST', buildStartPayload(profile));
} else if (action === 'status' && value) {
  await call(`/v1/campaigns/${encodeURIComponent(value)}`);
} else if (action === 'stop' && value) {
  await call(`/v1/campaigns/${encodeURIComponent(value)}/stop`, 'POST', {});
} else if (action === 'cleanup' && value) {
  await call(`/v1/campaigns/${encodeURIComponent(value)}/cleanup`, 'POST', { confirmation: `DELETE_ONLY_CAMPAIGN:${value}` });
} else if (action === 'verify-artifact' && value) {
  const jsonText = await readFile(value, 'utf8');
  const checksumText = await readFile(`${value.replace(/\.json$/, '')}.sha256`, 'utf8');
  const result = verifyCampaignArtifact(jsonText, checksumText);
  const rawFile = value.replace(/\.json$/, '.jsonl');
  let rawResult = null;
  if (result.valid) rawResult = verifyRawSampleArtifact(await readFile(rawFile, 'utf8'), await readFile(`${rawFile}.sha256`, 'utf8'), result.report.rawSamples?.rows);
  const valid = result.valid && rawResult?.valid === true;
  process.stdout.write(JSON.stringify({ valid, reason: result.reason ?? rawResult?.reason ?? null, campaignId: result.report?.campaignId ?? null, sha256: result.sha256 ?? null, rawSamplesVerified: rawResult?.valid ?? false, rawSampleRows: rawResult?.rows ?? 0, productionSloCertified: result.report?.productionSloCertified ?? false, missingMetrics: result.report?.missingMetrics ?? [] }, null, 2) + '\n');
  if (!valid) process.exitCode = 1;
} else {
  throw new Error('Usage: node scripts/validation/campaign-cli.mjs start [smoke|steady|burst|fault-injected] | status <id> | stop <id> | cleanup <id> | verify-artifact <path>');
}
}
