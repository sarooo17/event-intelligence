import assert from 'node:assert/strict';
import test from 'node:test';
import {
  verifyPostgresSteadySoakEvidence,
  STEADY_EVENTS,MIN_STEADY_MS,RATE_CAP_PER_SECOND,
} from '../scripts/evidence/postgres-steady-soak-gate.mjs';
import {
  PG_PIPELINE_RAW_SCHEMA,sha256OfRawEvidence,reopenedReceiptDigest,
} from '../scripts/lib/postgres-pipeline-raw-evidence.mjs';

const commit='a'.repeat(40);
const hist=s=>({samples:STEADY_EVENTS,p50Ms:s,p95Ms:s,p99Ms:s,maxMs:s});
function fixture(){
  const events=Array.from({length:STEADY_EVENTS},(_,index)=>({
    index,slot:index%16,matchId:'match-'+index,wakeId:'wake-'+index,
    receiptId:'receipt-'+index,candidateDefinitions:1,
    ingestToMatchMs:1,matchToWakeMs:2,ingestToWakeMs:3,
    hostCallbackMs:0.1,
  }));
  const reopenedReceipts=events.map(x=>({
    wakeId:x.wakeId,receiptId:x.receiptId,
    status:'delivered',attemptCount:1,
  }));
  const counters={xact_commit:100,xact_rollback:0,blks_read:0,blks_hit:100,
    tup_inserted:20,tup_updated:0,tup_deleted:0,
    temp_bytes:0,deadlocks:0,isolatedTableBytes:10000};
  const raw={
    schema:PG_PIPELINE_RAW_SCHEMA,scopeId:'steady-synthetic-fixture',
    sourceCommitSha:commit,
    measurementKind:'in-process-synthetic-source-and-local-host',
    providerTransportMeasured:false,externalHostEffectMeasured:false,
    postgresServiceCpuMeasured:false,measuredDurationMs:608000,
    postgres:{
      statement:'pg_stat_database counters are DB-wide, not EI-exclusive; PG service CPU not measured',
      before:counters,after:{...counters,xact_commit:101},
    },events,reopenedReceipts,
  };
  const bytes=Buffer.from(JSON.stringify(raw)+'\n');
  const summary={
    schema:'event-intelligence.postgres-mcp-ingest-wake.v1',
    status:'completed',runtime:{commit},
    workload:{
      triggers:16,distinctEventNames:8,
      matchingMcpOccurrences:STEADY_EVENTS,
      repeatedDistinctOccurrencesAcrossExistingTriggers:true,
      requestedMatchingEventsPerSecond:RATE_CAP_PER_SECOND,
      pacingMode:'monotonic-rate-cap',concurrency:1,
    },metrics:{
      ingestToMatch:hist(1),matchToWake:hist(2),
      ingestToWake:hist(3),hostCallback:hist(0.1),
      matchedCount:STEADY_EVENTS,durableWakeCount:STEADY_EVENTS,
      hostSideEffects:STEADY_EVENTS,duplicateHostSideEffects:0,
      falsePositiveWakeCount:0,measuredWallMs:608000,
      measuredMatchingEventsPerSecond:5,
    },evidence:{
      rawSamples:{sha256:sha256OfRawEvidence(bytes),
        reopenedReceiptDigest:reopenedReceiptDigest(reopenedReceipts)},
      persistedReceiptsCheckedAfterPoolReopen:STEADY_EVENTS,
      candidateDefinitionsPerMeasuredEvent:{
        samples:STEADY_EVENTS,min:1,max:1,average:1,
      },
      transportLatencyIncluded:false,hostExecutionLatencyIncluded:false,
      productionSloCertified:false,
    },
  };
  return {summary,raw,bytes};
}
test('steady 600s gate approves only complete bounded synthetic local PG evidence',()=>{
  const f=fixture();
  const verdict=verifyPostgresSteadySoakEvidence(
    f.summary,f.raw,f.bytes,{expectedCommitSha:commit});
  assert.equal(verdict.ok,true,verdict.failures.join(','));
  assert.ok(verdict.actualDurationMs>=MIN_STEADY_MS);
  assert.equal(verdict.actualEvents,STEADY_EVENTS);
  assert.equal(verdict.productionSloCertified,false);
});
test('steady gate rejects forged duration, throughput, identities and production attribution',()=>{
  const mutations=[
    f=>{f.raw.measuredDurationMs=599999;},
    f=>{f.raw.measuredDurationMs=999999;},
    f=>{f.summary.metrics.measuredMatchingEventsPerSecond=1000;},
    f=>{f.summary.metrics.measuredWallMs=1000;},
    f=>{f.summary.metrics.ingestToWake.p99Ms=0.01;},
    f=>{f.raw.events[0].receiptId=f.raw.events[1].receiptId;},
    f=>{f.raw.reopenedReceipts[0].receiptId='bogus';},
    f=>{f.raw.events.pop();},
    f=>{f.summary.workload.concurrency=2;},
    f=>{f.summary.workload.requestedMatchingEventsPerSecond=100;},
    f=>{f.summary.evidence.productionSloCertified=true;},
    f=>{f.raw.externalHostEffectMeasured=true;},
    f=>{f.summary.runtime.commit='b'.repeat(40);},
    f=>{f.bytes=Buffer.from('{}\n');},
  ];
  for(const mutate of mutations){
    const f=fixture(); mutate(f);
    const verdict=verifyPostgresSteadySoakEvidence(
      f.summary,f.raw,f.bytes,{expectedCommitSha:commit});
    assert.equal(verdict.ok,false,'tampered local soak accepted');
  }
});
