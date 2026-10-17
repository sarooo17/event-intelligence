import assert from 'node:assert/strict';
import test from 'node:test';
import {
  summarizeScaleEvidence, REQUIRED_SCALE_PROFILES,
} from '../scripts/evidence/postgres-scale-matrix.mjs';
const sha='a'.repeat(40);
function measured(profile) {
  const triggers=REQUIRED_SCALE_PROFILES[profile];
  const latency={samples:triggers,p50Ms:1,p95Ms:2,p99Ms:3,maxMs:4,meanMs:1.8};
  return {
    schema:'event-intelligence.postgres-durable-scale.v1',
    status:'completed',profile,triggerCount:triggers,wakes:128,
    runtime:{node:'v22.0.0',postgresVersion:'16.6',commit:sha},
    metrics:{
      register:{latency,triggersPerSecond:100},
      listAll:{durableRowsVerified:triggers},
      wakeClaim:{...latency,samples:128},
      wakeComplete:{...latency,samples:128},
      storageTotalBytes:4096*triggers,
    },
  };
}

test('single real-shaped profile is partial evidence, never 100k certification',()=>{
  const report=summarizeScaleEvidence([measured('1k')]);
  assert.equal(report.status,'incomplete-profiles');
  assert.deepEqual(report.missing,['10k','100k']);
  assert.equal(report.productionSloCertified,false);
  assert.equal(report.observed['1k'].triggers,1000);
  assert.equal(report.provenanceComplete,true);
});

test('complete three-profile fixture still does not claim production SLO',()=>{
  const report=summarizeScaleEvidence([
    measured('10k'),measured('1k'),measured('100k'),
  ]);
  assert.equal(report.status,'profiles-observed');
  assert.deepEqual(report.missing,[]);
  assert.equal(report.provenanceComplete,true);
  assert.equal(report.environmentsComparable,true);
  assert.equal(report.productionSloCertified,false);
});

test('missing real measurements, failed workloads, duplicates and fake counts are rejected',()=>{
  for(const modify of [
    x=>x.status='failed',
    x=>x.triggerCount=5000,
    x=>x.metrics.register.latency.p95Ms=-1,
    x=>x.metrics.wakeClaim.p99Ms=1,
    x=>x.metrics.storageTotalBytes=0,
    x=>x.metrics.listAll.durableRowsVerified=9,
    x=>delete x.metrics.wakeComplete,
  ]) {
    const x=measured('1k');
    modify(x);
    assert.throws(()=>summarizeScaleEvidence([x]),error=>
      error.code==='EI_PG_SCALE_EVIDENCE_INVALID');
  }
  assert.throws(()=>summarizeScaleEvidence([
    measured('1k'),measured('1k'),
  ]),error=>error.code==='EI_PG_SCALE_EVIDENCE_DUPLICATE');
});

test('incompatible environment or missing commit means incomplete provenance',()=>{
  const a=measured('1k'),b=measured('10k'),c=measured('100k');
  b.runtime.commit='b'.repeat(40);
  let report=summarizeScaleEvidence([a,b,c]);
  assert.equal(report.status,'incomplete-provenance');
  assert.equal(report.provenanceComplete,false);
  b.runtime.commit=sha;
  c.runtime.postgresVersion='15';
  report=summarizeScaleEvidence([a,b,c]);
  assert.equal(report.status,'incomplete-provenance');
  assert.equal(report.environmentsComparable,false);
});
