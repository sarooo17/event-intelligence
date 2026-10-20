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
  const registeredAt = Date.parse(budgets?.registeredAt);
  const observedAt = Date.parse(report?.observedAt);
  if (!Number.isFinite(registeredAt) || !Number.isFinite(observedAt) ||
      registeredAt >= observedAt) {
    missing.push('pre-registered-before-measurement');
  }
  for (const metric of METRICS) {
    if (!positive(budgets?.latencyP99MaxMs?.[metric])) {
      missing.push('pre-registered-budget:' + metric);
    }
  }
  if (!positive(budgets?.minVerifiedWakeRatePerSecond) ||
      !positive(budgets?.maxDuplicateEffectRate)) {
    // Explicitly allow maxDuplicateEffectRate=0: the intended strongest
    // limit for side-effect duplicates. Reject negative/NaN/unbounded.
    if (!positive(budgets?.minVerifiedWakeRatePerSecond)) {
      missing.push('pre-registered-min-throughput');
    }
    if (typeof budgets?.maxDuplicateEffectRate !== 'number' ||
        !Number.isFinite(budgets.maxDuplicateEffectRate) ||
        budgets.maxDuplicateEffectRate < 0 ||
        budgets.maxDuplicateEffectRate > 1) {
      missing.push('pre-registered-max-duplicate-rate');
    }
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
    if (typeof p.rawArtifactUrl !== 'string' ||
        !/^https:\/\/github\.com\/[^\s]+\/actions\/runs\/\d+/.test(p.rawArtifactUrl)) {
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
