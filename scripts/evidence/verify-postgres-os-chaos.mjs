#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function invalid(message) {
  const error = new Error('OS chaos evidence rejected: ' + message);
  error.code = 'EI_OS_CHAOS_EVIDENCE_INVALID';
  throw error;
}
function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function positivePid(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function getHostLine(host, key) {
  const hits = host.split(/\r?\n/).filter(line => line.startsWith(key + '='));
  if (hits.length !== 1) invalid('missing or duplicate host field ' + key);
  return hits[0].slice(key.length + 1);
}

/**
 * Verify internal integrity of a raw *actual-run* bundle. This is NOT a
 * cryptographic attestation of GitHub Actions, a provider/WAN chaos test,
 * or proof of end-to-end host exactly-once effects.
 */
export function verifyOsChaosEvidence({
  report, host, log, rounds, commit,
}) {
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 120) {
    invalid('expected round count must be integer 1..120');
  }
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/i.test(commit)) {
    invalid('expected commit must be an exact 40-character SHA');
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    invalid('JSON report is not an object');
  }
  if (report.status === 'incomplete') invalid('incomplete-run failure marker');
  if (report.schema !== 'ei-postgres-os-chaos-v1' ||
      report.kind !== 'bounded-process-kill-and-reclaim') {
    invalid('wrong report schema/kind; no successful soak evidence');
  }
  if (report.rounds !== rounds || report.killsConfirmed !== rounds ||
      report.recoveredReceipts !== rounds) {
    invalid('rounds, SIGKILL count or recovered receipts differ from requested rounds');
  }
  if (!Array.isArray(report.evidence) || report.evidence.length !== rounds) {
    invalid('per-round evidence length mismatch');
  }
  // The producing node:test fixture is itself limited to this exact
  // deadline (95 seconds or 12 seconds per round). A verified successful
  // Github-run result cannot claim astronomical wall times; this also
  // prevents floating-point additions from absorbing small round durations.
  const maxFixtureMs = Math.max(95000, rounds * 12000);
  if (!positiveNumber(report.totalDurationMs) ||
      report.totalDurationMs > maxFixtureMs ||
      !report.handoverMs || typeof report.handoverMs !== 'object') {
    invalid('missing or impossible bounded fixture duration and percentiles');
  }
  if (typeof report.node !== 'string' || !/^v[0-9]+\./.test(report.node) ||
      typeof report.postgresVersion !== 'string' || !report.postgresVersion ||
      typeof report.pgDriverVersion !== 'string' || !report.pgDriverVersion ||
      typeof report.platform !== 'string' || !report.platform ||
      typeof report.arch !== 'string' || !report.arch) {
    invalid('missing Node, PostgreSQL, driver or host platform provenance');
  }
  if (typeof host !== 'string' || typeof log !== 'string') {
    invalid('host provenance and full test log are mandatory');
  }
  if (getHostLine(host, 'source-head-sha').toLowerCase() !== commit.toLowerCase() ||
      getHostLine(host, 'rounds') !== String(rounds)) {
    invalid('host SHA or requested rounds do not match exact expected run');
  }
  if (getHostLine(host, 'pg-driver') !== report.pgDriverVersion ||
      report.pgDriverVersion !== '8.16.3') {
    invalid('unmatched or unpinned PostgreSQL driver');
  }
  const hostNodeVersions = host.split(/\r?\n/).filter(x => /^v[0-9]+\.[0-9]+\.[0-9]+/.test(x));
  if (hostNodeVersions.length !== 1 || hostNodeVersions[0] !== report.node) {
    invalid('Node version in report does not match host');
  }
  if (!/^[0-9]+$/.test(getHostLine(host, 'run-id')) ||
      !/^[1-9][0-9]*$/.test(getHostLine(host, 'run-attempt'))) {
    invalid('missing GitHub Actions run identity');
  }
  if (!/^ok 1 - real SIGKILL PostgreSQL worker takeovers/m.test(log) ||
      !/^# pass 1\s*$/m.test(log) ||
      !/^# fail 0\s*$/m.test(log) ||
      /^not ok /m.test(log)) {
    invalid('test log does not show exactly one successful OS-kill test');
  }

  const receipts = new Set();
  const timings = [];
  for (const [i, row] of report.evidence.entries()) {
    if (!row || typeof row !== 'object' ||
        row.round !== i ||
        row.killedSignal !== 'SIGKILL' || row.generation !== 2 ||
        row.workerId !== (i % 2 === 0 ? 'logical-worker-a' : 'logical-worker-b') ||
        !positivePid(row.victimPid) || !positivePid(row.successorPid) ||
        row.victimPid === row.successorPid ||
        !positiveNumber(row.handoverMs) ||
        row.handoverMs > report.totalDurationMs) {
      invalid('invalid kill/reclaim/fencing evidence in round ' + i);
    }
    const requiredReceipt = 'fixture-receipt-os-kill-wake-' + i;
    if (row.receiptId !== requiredReceipt || receipts.has(row.receiptId)) {
      invalid('missing or duplicate persisted fixture receipt at round ' + i);
    }
    receipts.add(row.receiptId);
    timings.push(row.handoverMs);
  }
  // The producer measures rounds serially inside the total wall-clock
  // window. A forged aggregate shorter than their sum must never pass:
  // compare the UNSORTED per-round sum, with floating-point tolerance.
  let sumOfRoundsMs = 0;
  for (const value of timings) {
    sumOfRoundsMs += value;
    if (!Number.isFinite(sumOfRoundsMs)) {
      invalid('sum of sequential round durations overflowed');
    }
  }
  // Bound the rounding allowance: using an unbounded relative tolerance
  // could otherwise silently bless physically impossible huge run totals.
  const roundingToleranceMs = Math.max(
    0.001, Math.min(1, sumOfRoundsMs * 1e-12),
  );
  if (report.totalDurationMs + roundingToleranceMs < sumOfRoundsMs) {
    invalid('total wall duration is shorter than the sum of sequential rounds');
  }
  timings.sort((a, b) => a - b);
  for (const [label, p] of [['p50', .5], ['p95', .95], ['p99', .99]]) {
    const expected = timings[Math.min(timings.length - 1, Math.ceil(p * timings.length) - 1)];
    const observed = report.handoverMs[label];
    if (!positiveNumber(observed) || Math.abs(observed - expected) > 0.000001) {
      invalid('tampered or inconsistent ' + label + ' handover percentile');
    }
  }
  if (typeof report.limits !== 'string' ||
      !report.limits.includes('no provider/match/wake end-to-end')) {
    invalid('missing explicitly limited fixture scope');
  }
  return {
    schema: 'ei-postgres-os-chaos-verification.v1',
    ok: true,
    sourceCommit: commit.toLowerCase(),
    actionsRunId: getHostLine(host, 'run-id'),
    actionsRunAttempt: Number(getHostLine(host, 'run-attempt')),
    rounds,
    killsConfirmed: receipts.size,
    recoveredReceipts: receipts.size,
    handoverMs: report.handoverMs,
    limits: 'Fixture-only process SIGKILL/PG lease-reclaim. GitHub run conclusion and archive authenticity must be verified separately.',
  };
}

async function main(args) {
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--(json|host|log|rounds|commit)$/.test(args[i] ?? '') ||
        !args[i + 1] || options.has(args[i])) {
      invalid('require --json --host --log --rounds --commit once each');
    }
    options.set(args[i], args[i + 1]);
  }
  if (options.size !== 5) invalid('require --json --host --log --rounds --commit');
  const [json, host, log] = await Promise.all([
    readFile(options.get('--json'), 'utf8'),
    readFile(options.get('--host'), 'utf8'),
    readFile(options.get('--log'), 'utf8'),
  ]);
  const result = verifyOsChaosEvidence({
    report: JSON.parse(json), host, log,
    rounds: Number(options.get('--rounds')),
    commit: options.get('--commit'),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(JSON.stringify({
      schema: 'ei-postgres-os-chaos-verification.v1',
      ok: false, error: error?.message ?? 'invalid evidence',
    }) + '\n');
    process.exitCode = 1;
  });
}
