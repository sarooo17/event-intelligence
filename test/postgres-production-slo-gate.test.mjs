import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPostgresProductionSloEvidence } from
  '../scripts/evidence/postgres-production-slo-gate.mjs';

const latency = () => ({
  samples: 1000, p50Ms: 5, p95Ms: 18, p99Ms: 42, maxMs: 90,
});
const actualProfileTimes = Object.freeze({
  steady: ['2026-10-20T08:00:00Z','2026-10-20T08:10:00Z'],
  burst: ['2026-10-20T09:00:00Z','2026-10-20T09:10:00Z'],
  'fault-injected': ['2026-10-20T10:00:00Z','2026-10-20T10:10:00Z'],
});
function completeProfile(name) {
  const [startedAt,finishedAt] = actualProfileTimes[name];
  return {
    name, startedAt, finishedAt, durationSeconds:600,
    requestedEventRatePerSecond:10,
    observedEventRatePerSecond:9.5,
    workers:4,partitions:128,
    expectedWakes:6000,persistedDeliveredWakes:6000,verifiedWakes:6000,duplicateHostEffects:0,
    wakeSettlement:{settled:true,persistedDeliveredWakeCount:6000,verifiedHostReceipts:6000,dueWakeBacklog:0,pendingWakeDeliveries:0,deadLetterWakeDeliveries:0},
    providerTransportMeasured:true,externalHostEffectMeasured:true,
    postgresServiceResourcesMeasured:true,
    rawArtifactUrl:'https://github.com/sarooo17/event-intelligence/actions/runs/123456',
    latency:{
      providerToIngest:latency(),ingestToMatch:latency(),
      matchToWake:latency(),hostEffect:latency(),
    },
    ...(name==='fault-injected' ? {
      faults:['worker-kill','database-unavailable','partition-rebalance'],
    } : {}),
  };
}
function sample() {
  return {
    schema:'event-intelligence.postgres-production-slo-evidence.v1',
    productionSloCertified:false,
    observedAt:'2026-10-20T13:00:00Z',
    preRegisteredSloBudgets:{
      registeredAt:'2026-10-19T12:00:00Z',
      latencyP99MaxMs:{
        providerToIngest:100,ingestToMatch:120,
        matchToWake:180,hostEffect:200,
      },
      minVerifiedWakeRatePerSecond:5,maxDuplicateEffectRate:0,
    },
    environment:{
      node:'v22',postgres:'16',pgDriver:'8',cpuModel:'benchmark-fixture',
      memoryBytes:4*1024**3,sourceCommitSha:'deadbeef',
    },
    profiles:['steady','burst','fault-injected'].map(completeProfile),
  };
}

test('pre-signoff SLO gate never self-certifies even a structurally complete report',()=>{
  const result=assessPostgresProductionSloEvidence(sample());
  assert.deepEqual(result,{
    schema:'event-intelligence.postgres-production-slo-assessment.v1',
    status:'eligible-for-independent-review',
    productionSloCertified:false,operatorSignoffRequired:true,missing:[],
  });
});

test('existing synthetic PG event-to-wake benchmark cannot masquerade as production SLO',()=>{
  const report={
    schema:'event-intelligence.postgres-mcp-ingest-wake.v1',
    workload:{concurrency:1,host:'in-process counted callback'},
    metrics:{ingestToMatch:{samples:16,p99Ms:34}},
    evidence:{transportLatencyIncluded:false,hostExecutionLatencyIncluded:false},
    productionSloCertified:true,
  };
  const result=assessPostgresProductionSloEvidence(report);
  assert.equal(result.status,'blocked');
  assert.ok(result.missing.includes('report-schema'));
  assert.ok(result.missing.includes('self-certification-forbidden'));
  assert.ok(result.missing.includes('profile:steady'),
    'the synthetic report lacks the required steady workload entirely');
  assert.equal(result.productionSloCertified,false);
});

test('narrow two-sample p99, absent provider/host and false loss accounting fail closed',()=>{
  const report=sample();
  report.profiles[0].latency.ingestToMatch.samples=2;
  report.profiles[0].externalHostEffectMeasured=false;
  report.profiles[1].verifiedWakes=5999;
  report.profiles[2].persistedDeliveredWakes=5999;
  report.profiles[0].wakeSettlement.dueWakeBacklog=1;
  report.profiles[2].faults=['worker-kill'];
  const result=assessPostgresProductionSloEvidence(report);
  assert.equal(result.status,'blocked');
  assert.ok(result.missing.includes('steady:measured-1000-sample-tail:ingestToMatch'));
  assert.ok(result.missing.includes('steady:provider-host-db-attribution'));
  assert.ok(result.missing.includes('burst:durable-wake-and-duplicate-accounting'));
  assert.ok(result.missing.includes('fault-injected:durable-wake-and-duplicate-accounting'));
  assert.ok(result.missing.includes('steady:durable-wake-and-duplicate-accounting'));
  assert.ok(result.missing.includes('fault-injected:required-independent-faults'));
});

test('retrospective budgets and incomplete resource attribution cannot clear guard',()=>{
  const report=sample();
  report.preRegisteredSloBudgets.registeredAt='2026-10-21T00:00:00Z';
  report.preRegisteredSloBudgets.maxDuplicateEffectRate=-1;
  report.environment.memoryBytes=null;
  report.profiles[2].latency.hostEffect.p95Ms=250;
  report.profiles[2].latency.hostEffect.p99Ms=100;
  const result=assessPostgresProductionSloEvidence(report);
  assert.equal(result.status,'blocked');
  for(const expected of [
    'pre-registered-before-measurement',
    'pre-registered-max-duplicate-rate','environment:memoryBytes',
    'fault-injected:measured-1000-sample-tail:hostEffect',
  ])assert.ok(result.missing.includes(expected),expected);
});


test('malformed profile shapes fail closed instead of throwing before manual review',()=>{
  for(const profiles of [null,{},'invalid',[],[{name:'steady'}]]) {
    const report=sample();
    report.profiles=profiles;
    const result=assessPostgresProductionSloEvidence(report);
    assert.equal(result.status,'blocked');
    assert.equal(result.productionSloCertified,false);
    assert.ok(result.missing.includes('steady-burst-fault-profile-matrix'));
  }
});

test('duplicate-rate budget is always in [0,1], including when throughput is valid',()=>{
  for(const rate of [-1,2,Number.POSITIVE_INFINITY,Number.NaN,'0.5',null]) {
    const input=sample();
    input.preRegisteredSloBudgets.maxDuplicateEffectRate=rate;
    const result=assessPostgresProductionSloEvidence(input);
    assert.equal(result.status,'blocked',String(rate));
    assert.ok(result.missing.includes('pre-registered-max-duplicate-rate'),
      String(rate));
  }
  for(const rate of [0,0.02,1]){
    const input=sample();
    input.preRegisteredSloBudgets.maxDuplicateEffectRate=rate;
    assert.equal(assessPostgresProductionSloEvidence(input).status,
      'eligible-for-independent-review');
  }
});

test('untrusted timestamps must be valid explicit ISO strings with timezone',()=>{
  for(const invalid of [0,1,20261020,null,{},'', '2026-10-20',
    '2026-02-30T10:00:00Z','2026-13-01T10:00:00Z',
    '2026-10-20T25:00:00Z','2026-10-20T10:00:00+14:30']) {
    for(const key of ['registeredAt','observedAt']) {
      const input=sample();
      if(key==='registeredAt')input.preRegisteredSloBudgets.registeredAt=invalid;
      else input.observedAt=invalid;
      const result=assessPostgresProductionSloEvidence(input);
      assert.equal(result.status,'blocked',key+':'+String(invalid));
      assert.ok(result.missing.includes('pre-registered-before-measurement'));
    }
  }
  const input=sample();
  input.preRegisteredSloBudgets.registeredAt='2026-10-19T14:00:00+02:00';
  assert.equal(assessPostgresProductionSloEvidence(input).status,
    'eligible-for-independent-review');
});

test('raw benchmark evidence requires complete anchored GitHub Actions run URL',()=>{
  const invalid=[
    'https://github.com/o/actions/runs/123',
    'https://github.com/o/r/actions/runs/123/malicious',
    'https://github.com/o/r/actions/runs/123?faked=1',
    'https://github.com/o/r/actions/runs/0',
    'https://github.com/o/r/issues/123',
    'http://github.com/o/r/actions/runs/123',
    'https://github.com/o/r/actions/runs/123#faked',
    'https://github.com/o/../actions/runs/123',
    'https://github.com/o/./actions/runs/123',
    'https://github.com/./r/actions/runs/123',
    'https://github.com/../r/actions/runs/123',
    'https://github.com/-owner/r/actions/runs/123',
    'https://github.com/owner-/r/actions/runs/123',
    'https://github.com/invalid--owner/repo/actions/runs/123',
    'https://github.com/owner---three/repo/actions/runs/123',
    'https://github.com/o/./r/actions/runs/123',
    'https://github.com/o/%2e%2e/actions/runs/123',
  ];
  for(const url of invalid){
    const input=sample();
    input.profiles[0].rawArtifactUrl=url;
    const result=assessPostgresProductionSloEvidence(input);
    assert.equal(result.status,'blocked',url);
    assert.ok(result.missing.includes('steady:raw-public-run-artifact'),url);
  }
  const input=sample();
  input.profiles[0].rawArtifactUrl=
    'https://github.com/owner/repository/actions/runs/12345/attempts/2';
  assert.equal(assessPostgresProductionSloEvidence(input).status,
    'eligible-for-independent-review');
});

test('measured p99 above its pre-registered budget is not eligible for signoff',()=>{
  const report=sample();
  report.profiles[0].latency.matchToWake.p99Ms=181;
  report.profiles[0].latency.matchToWake.maxMs=300;
  const result=assessPostgresProductionSloEvidence(report);
  assert.equal(result.status,'blocked');
  assert.ok(result.missing.includes('steady:p99-over-budget:matchToWake'));
  assert.equal(result.productionSloCertified,false);
});

test('wake throughput must use durable verified receipts, not requested or event rates',()=>{
  const report=sample();
  report.preRegisteredSloBudgets.minVerifiedWakeRatePerSecond=11;
  // Raw provider rate claims cannot hide the observed 6000/600=10 wakes/s.
  report.profiles[1].observedEventRatePerSecond=99;
  const result=assessPostgresProductionSloEvidence(report);
  assert.equal(result.status,'blocked');
  assert.ok(result.missing.includes('burst:verified-wake-throughput-below-budget'));
});

test('actual duplicate host-effect rate cannot exceed registered allowance',()=>{
  const report=sample();
  report.profiles[2].duplicateHostEffects=1;
  const result=assessPostgresProductionSloEvidence(report);
  assert.equal(result.status,'blocked');
  assert.ok(result.missing.includes('fault-injected:duplicate-host-effect-rate-over-budget'));
  report.preRegisteredSloBudgets.maxDuplicateEffectRate=0.001;
  const withinBudget=assessPostgresProductionSloEvidence(report);
  assert.equal(withinBudget.status,'eligible-for-independent-review');
});

test('exactly-at-budget measured rate and p99 are admissible, not certified',()=>{
  const report=sample();
  report.preRegisteredSloBudgets.minVerifiedWakeRatePerSecond=10;
  report.preRegisteredSloBudgets.latencyP99MaxMs.matchToWake=42;
  const result=assessPostgresProductionSloEvidence(report);
  assert.equal(result.status,'eligible-for-independent-review');
  assert.equal(result.productionSloCertified,false);
});

test('operator SLO budgets must predate EACH measured profile, not just report creation',()=>{
  const input=sample();
  input.profiles[0].startedAt='2026-10-19T11:59:59Z';
  const result=assessPostgresProductionSloEvidence(input);
  assert.equal(result.status,'blocked');
  assert.ok(result.missing.includes('steady:observed-timeline-and-budget-order'));
  assert.equal(result.productionSloCertified,false);
});

test('per-profile timeline refuses impossible dates, duration mismatches and post-report runs',()=>{
  const variants=[
    ['2026-02-30T08:00:00Z','2026-10-20T08:10:00Z',600],
    ['2026-10-20T08:10:00Z','2026-10-20T08:00:00Z',600],
    ['2026-10-20T08:00:00Z','2026-10-20T08:00:10Z',600],
    ['2026-10-20T12:59:00Z','2026-10-20T13:10:00Z',660],
    ['2026-10-20T08:00:00Z','2026-10-20T08:09:58Z',600],
  ];
  for(const [startedAt,finishedAt,durationSeconds] of variants){
    const input=sample();
    Object.assign(input.profiles[0],{startedAt,finishedAt,durationSeconds});
    const result=assessPostgresProductionSloEvidence(input);
    assert.equal(result.status,'blocked',JSON.stringify([startedAt,finishedAt,durationSeconds]));
    assert.ok(result.missing.includes('steady:observed-timeline-and-budget-order'));
  }
  const success=sample();
  success.profiles[2].startedAt='2026-10-20T12:45:00+02:00';
  success.profiles[2].finishedAt='2026-10-20T12:55:00+02:00';
  assert.equal(assessPostgresProductionSloEvidence(success).status,
    'eligible-for-independent-review');
});
