#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  verifyPostgresPipelineRawEvidence, sha256OfRawEvidence,
} from '../lib/postgres-pipeline-raw-evidence.mjs';

export const MIN_STEADY_MS = 600_000;
export const STEADY_EVENTS = 3_040;
export const RATE_CAP_PER_SECOND = 5;

/**
 * Reject incomplete/forged local PostgreSQL steady-state artifacts.
 * This is a preproduction, one-worker, in-process provider/host baseline.
 * It MUST NOT be used to satisfy external end-to-end SLO signoff.
 */
export function verifyPostgresSteadySoakEvidence(summary,raw,rawBytes,{
  expectedCommitSha,
}={}){
  const failures=[];
  const check=(yes,code)=>{if(!yes)failures.push(code);};
  const validation=verifyPostgresPipelineRawEvidence(summary,raw);
  check(validation.ok,'raw-evidence:'+validation.failures.join(','));
  check(Buffer.isBuffer(rawBytes) &&
    summary?.evidence?.rawSamples?.sha256===sha256OfRawEvidence(rawBytes),
    'saved-byte-checksum');
  check(typeof expectedCommitSha==='string' &&
    /^[0-9a-f]{40}$/.test(expectedCommitSha) &&
    summary?.runtime?.commit===expectedCommitSha &&
    raw?.sourceCommitSha===expectedCommitSha,'exact-head-provenance');
  // The workflow uses postgres:16-alpine but a standalone artifact verifier
  // MUST validate the server-reported major version before advertising PG16.
  check(typeof summary?.runtime?.postgresVersion==='string' &&
    /^16(?:[.]|$)/.test(summary.runtime.postgresVersion.trim()),
    'recorded-server-version-must-be-postgresql-16');
  check(summary?.workload?.triggers===16 &&
    summary?.workload?.distinctEventNames===8 &&
    summary?.workload?.matchingMcpOccurrences===STEADY_EVENTS &&
    summary?.workload?.repeatedDistinctOccurrencesAcrossExistingTriggers===true &&
    summary?.workload?.requestedMatchingEventsPerSecond===RATE_CAP_PER_SECOND &&
    summary?.workload?.pacingMode==='monotonic-rate-cap' &&
    summary?.workload?.concurrency===1,'workload-pre-registration');
  check(raw?.events?.length===STEADY_EVENTS &&
    summary?.evidence?.persistedReceiptsCheckedAfterPoolReopen===STEADY_EVENTS,
    'complete-soak-receipts');
  check(Number.isFinite(raw?.measuredDurationMs) &&
    raw.measuredDurationMs>=MIN_STEADY_MS &&
    summary?.metrics?.measuredWallMs>=MIN_STEADY_MS,
    'measured-minimum-duration');
  check(summary?.metrics?.duplicateHostSideEffects===0 &&
    summary?.metrics?.falsePositiveWakeCount===0 &&
    summary?.metrics?.hostSideEffects===STEADY_EVENTS &&
    summary?.metrics?.matchedCount===STEADY_EVENTS,
    'no-loss-or-unaccounted-effects');
  check(raw?.measurementKind==='in-process-synthetic-source-and-local-host' &&
    raw?.providerTransportMeasured===false &&
    raw?.externalHostEffectMeasured===false &&
    raw?.postgresServiceCpuMeasured===false &&
    summary?.evidence?.productionSloCertified===false,
    'no-remote-production-claim');
  return Object.freeze({ok:failures.length===0,failures:Object.freeze(failures),
    actualDurationMs:raw?.measuredDurationMs??null,
    actualEvents:raw?.events?.length??0,productionSloCertified:false});
}

if(process.argv[1]?.endsWith('postgres-steady-soak-gate.mjs')){
  try{
    const [summaryPath,rawPath,expectedCommitSha]=process.argv.slice(2);
    assert.ok(summaryPath&&rawPath&&expectedCommitSha,
      'usage: node scripts/evidence/postgres-steady-soak-gate.mjs SUMMARY RAW SHA');
    const rawBytes=readFileSync(rawPath);
    const summary=JSON.parse(readFileSync(summaryPath,'utf8'));
    const raw=JSON.parse(rawBytes.toString('utf8'));
    const checked=verifyPostgresSteadySoakEvidence(
      summary,raw,rawBytes,{expectedCommitSha});
    assert.equal(checked.ok,true,checked.failures.join('; '));
    process.stdout.write(JSON.stringify({
      ...checked,
      measuredIngestToWakeP99Ms:summary.metrics.ingestToWake.p99Ms,
      achievedMatchingEventsPerSecond:summary.metrics.measuredMatchingEventsPerSecond,
      scope:'real PostgreSQL16, one Node worker, synthetic in-process provider, local counted host',
    })+'\n');
  }catch(error){
    process.stderr.write(JSON.stringify({
      ok:false,productionSloCertified:false,error:String(error?.message??error),
    })+'\n');
    process.exitCode=1;
  }
}
