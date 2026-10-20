/**
 * Production-SLO evidence completeness gate (#47).
 *
 * It only checks whether a submitted report is structurally fit for an
 * independent performance review. It NEVER certifies an SLO or publishes
 * software. Network/provider latency and host effect time must be measured
 * separately from EI's durable event-to-wake span; synthetic local
 * callbacks cannot satisfy either requirement.
 */
const METRICS = Object.freeze([
  'providerToIngest', 'ingestToMatch', 'matchToWake', 'hostEffect',
]);
const PROFILES = Object.freeze(['steady', 'burst', 'fault-injected']);

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Require an explicit, canonical ISO calendar timestamp with timezone.
// Date.parse(0), Date.parse(1) and malformed/normalized calendar dates are
// not admissible evidence of pre-registered operator budgets.
function evidenceTimestamp(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value);
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Reject invalid dates which Date.parse may silently normalize, including
  // February 30, by comparing the UTC calendar tuple before offsets.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year ||
      calendar.getUTCMonth() !== month - 1 ||
      calendar.getUTCDate() !== day) return NaN;
  const offset = match[8];
  if (offset !== 'Z' && Number(offset.slice(1,3)) === 14 &&
      Number(offset.slice(4,6)) !== 0) return NaN;
  return Date.parse(value);
}

// Reject URL dot segments BEFORE parsing or using a public artifact link:
 // WHATWG URL normalizes /owner/../ to a different resource.
function canonicalGitHubActionsRunUrl(value) {
  if (typeof value !== 'string') return false;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/actions\/runs\/[1-9]\d*(?:\/attempts\/[1-9]\d*)?$/.exec(value);
  if (!match) return false;
  const [, owner, repository] = match;
  return !owner.startsWith('-') && !owner.endsWith('-') &&
    !owner.includes('--') && repository !== '.' && repository !== '..';
}

function percentileSeries(value) {
  return value && Number.isSafeInteger(value.samples) && value.samples >= 1000 &&
    [value.p50Ms, value.p95Ms, value.p99Ms, value.maxMs].every(
      item => typeof item === 'number' && Number.isFinite(item) && item >= 0
    ) && value.p50Ms <= value.p95Ms &&
    value.p95Ms <= value.p99Ms && value.p99Ms <= value.maxMs;
}

export function assessPostgresProductionSloEvidence(report) {
  const missing = [];
  if (report?.schema !== 'event-intelligence.postgres-production-slo-evidence.v1') {
    missing.push('report-schema');
  }
  if (report?.productionSloCertified === true) {
    missing.push('self-certification-forbidden');
  }
  const budgets = report?.preRegisteredSloBudgets;
  const registeredAt = evidenceTimestamp(budgets?.registeredAt);
  const observedAt = evidenceTimestamp(report?.observedAt);
  if (!Number.isFinite(registeredAt) || !Number.isFinite(observedAt) ||
      registeredAt >= observedAt) {
    missing.push('pre-registered-before-measurement');
  }
  for (const metric of METRICS) {
    if (!positive(budgets?.latencyP99MaxMs?.[metric])) {
      missing.push('pre-registered-budget:' + metric);
    }
  }
  if (!positive(budgets?.minVerifiedWakeRatePerSecond)) {
    missing.push('pre-registered-min-throughput');
  }
  // The range check must be unconditional: 0 is valid, but a positive
  // bound like 2 is NOT a rate and Infinity is not a bound at all.
  const maximumDuplicateRate = budgets?.maxDuplicateEffectRate;
  if (typeof maximumDuplicateRate !== 'number' ||
      !Number.isFinite(maximumDuplicateRate) ||
      maximumDuplicateRate < 0 || maximumDuplicateRate > 1) {
    missing.push('pre-registered-max-duplicate-rate');
  }
  const environment = report?.environment;
  for (const key of ['node', 'postgres', 'pgDriver', 'cpuModel',
    'memoryBytes', 'sourceCommitSha']) {
    const value = environment?.[key];
    if ((key === 'memoryBytes' && !positive(value)) ||
      (key !== 'memoryBytes' && (typeof value !== 'string' || !value.trim()))) {
      missing.push('environment:' + key);
    }
  }
  const profiles = Array.isArray(report?.profiles) ? report.profiles : [];
  if (profiles.length !== PROFILES.length ||
      new Set(profiles.map(row=>row?.name)).size !== PROFILES.length) {
    missing.push('steady-burst-fault-profile-matrix');
  }
  for (const name of PROFILES) {
    const p = profiles.find(row => row?.name === name);
    if (!p) {
      missing.push('profile:' + name);
      continue;
    }
    if (!positive(p.durationSeconds) ||
        p.durationSeconds < 600 ||
        !positive(p.requestedEventRatePerSecond) ||
        !positive(p.observedEventRatePerSecond) ||
        !Number.isSafeInteger(p.workers) || p.workers < 2 ||
        !Number.isSafeInteger(p.partitions) || p.partitions < 2) {
      missing.push(name + ':sustained-multiworker-workload');
    }
    if (!Number.isSafeInteger(p.expectedWakes) ||
        p.expectedWakes < 1000 ||
        p.verifiedWakes !== p.expectedWakes ||
        !Number.isSafeInteger(p.duplicateHostEffects) ||
        p.duplicateHostEffects < 0) {
      missing.push(name + ':durable-wake-and-duplicate-accounting');
    }
    if (p.providerTransportMeasured !== true ||
        p.externalHostEffectMeasured !== true ||
        p.postgresServiceResourcesMeasured !== true) {
      missing.push(name + ':provider-host-db-attribution');
    }
    if (!canonicalGitHubActionsRunUrl(p.rawArtifactUrl)) {
      missing.push(name + ':raw-public-run-artifact');
    }
    for (const metric of METRICS) {
      if (!percentileSeries(p.latency?.[metric])) {
        missing.push(name + ':measured-1000-sample-tail:' + metric);
      }
    }
    if (name === 'fault-injected' && (
        !Array.isArray(p.faults) ||
        !p.faults.includes('worker-kill') ||
        !p.faults.includes('database-unavailable') ||
        !p.faults.includes('partition-rebalance'))) {
      missing.push('fault-injected:required-independent-faults');
    }
  }
  return Object.freeze({
    schema:'event-intelligence.postgres-production-slo-assessment.v1',
    status:missing.length ? 'blocked' : 'eligible-for-independent-review',
    // This gate verifies only JSON *claims*. A reviewer must independently
    // inspect artifacts, source SHA, runner/hardware and run timestamps.
    productionSloCertified:false,
    operatorSignoffRequired:true,
    missing:Object.freeze(missing),
  });
}
