import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPostgresProductionSloEvidence } from
  '../scripts/evidence/postgres-production-slo-gate.mjs';

const latency = () => ({
  samples: 1000, p50Ms: 5, p95Ms: 18, p99Ms: 42, maxMs: 90,
});
function completeProfile(name) {
  return {
    name, durationSeconds:600,
    requestedEventRatePerSecond:10,
    observedEventRatePerSecond:9.5,
    workers:4,partitions:128,
    expectedWakes:6000,verifiedWakes:6000,duplicateHostEffects:0,
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
  assert.ok(result.missing.some(x=>x.startsWith('steady:')));
  assert.equal(result.productionSloCertified,false);
});

test('narrow two-sample p99, absent provider/host and false loss accounting fail closed',()=>{
  const report=sample();
  report.profiles[0].latency.ingestToMatch.samples=2;
  report.profiles[0].externalHostEffectMeasured=false;
  report.profiles[1].verifiedWakes=5999;
  report.profiles[2].faults=['worker-kill'];
  const result=assessPostgresProductionSloEvidence(report);
  assert.equal(result.status,'blocked');
  assert.ok(result.missing.includes('steady:measured-1000-sample-tail:ingestToMatch'));
  assert.ok(result.missing.includes('steady:provider-host-db-attribution'));
  assert.ok(result.missing.includes('burst:durable-wake-and-duplicate-accounting'));
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
