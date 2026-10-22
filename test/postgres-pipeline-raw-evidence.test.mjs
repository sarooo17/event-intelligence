import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {PG_PIPELINE_RAW_SCHEMA,verifyPostgresPipelineRawEvidence,
  reopenedReceiptDigest,publishPostgresPipelineRawEvidence,sha256OfRawEvidence} from
  '../scripts/lib/postgres-pipeline-raw-evidence.mjs';

const summarySchema='event-intelligence.postgres-mcp-ingest-wake.v1';
function fixture(){
  const values=[
    {match:1,wake:2,host:0.1,candidates:1},
    {match:4,wake:3,host:0.2,candidates:2},
    {match:2,wake:1,host:0.4,candidates:1},
    {match:3,wake:5,host:0.3,candidates:1},
  ];
  const events=values.map(({match,wake,host,candidates},index)=>({
    index,slot:index%2,matchId:'match-'+index,wakeId:'wake-'+index,
    receiptId:'receipt-'+index,candidateDefinitions:candidates,
    ingestToMatchMs:match,matchToWakeMs:wake,
    ingestToWakeMs:match+wake,hostCallbackMs:host,
  }));
  const q=items=>{const sorted=[...items].sort((a,b)=>a-b);
    return {samples:sorted.length,p50Ms:sorted[1],p95Ms:sorted[3],
      p99Ms:sorted[3],maxMs:sorted[3]};};
  const stats={xact_commit:100,xact_rollback:1,blks_read:2,blks_hit:3,
    tup_inserted:4,tup_updated:5,tup_deleted:6,temp_bytes:7,
    deadlocks:0,isolatedTableBytes:9000};
  const commit='a'.repeat(40);
  const reopenedReceipts=events.map(e=>({
    wakeId:e.wakeId,receiptId:e.receiptId,status:'delivered',attemptCount:1,
  }));
  const summary={schema:summarySchema,status:'completed',
    runtime:{commit},
    workload:{triggers:2,matchingMcpOccurrences:4},
    metrics:{
      ingestToMatch:q(events.map(x=>x.ingestToMatchMs)),
      matchToWake:q(events.map(x=>x.matchToWakeMs)),
      ingestToWake:q(events.map(x=>x.ingestToWakeMs)),
      hostCallback:q(events.map(x=>x.hostCallbackMs)),
      matchedCount:4,durableWakeCount:4,hostSideEffects:4,
      duplicateHostSideEffects:0,
      measuredWallMs:1000,
      measuredMatchingEventsPerSecond:4,
    },
    evidence:{persistedReceiptsCheckedAfterPoolReopen:4,
      transportLatencyIncluded:false,hostExecutionLatencyIncluded:false,
      candidateDefinitionsPerMeasuredEvent:{samples:4,min:1,max:2,average:1.25},
      rawSamples:{reopenedReceiptDigest:reopenedReceiptDigest(reopenedReceipts)}},
  };
  const raw={schema:PG_PIPELINE_RAW_SCHEMA,scopeId:'fixture-scope',
    sourceCommitSha:commit,
    measurementKind:'in-process-synthetic-source-and-local-host',
    providerTransportMeasured:false,externalHostEffectMeasured:false,
    postgresServiceCpuMeasured:false,
    measuredDurationMs:1000,
    postgres:{
      statement:'pg_stat_database counters are DB-wide, not EI-exclusive; PG service CPU not measured',
      before:stats,after:{...stats,xact_commit:120}},
    events,reopenedReceipts};
  return {summary,raw};
}
test('raw PG pipeline verifier recomputes all four percentile streams and durable identities',()=>{
  const {summary,raw}=fixture();
  const result=verifyPostgresPipelineRawEvidence(summary,raw);
  assert.equal(result.ok,true,result.failures.join(','));
  assert.equal(result.productionSloCertified,false);
});
test('raw PG pipeline proof rejects tampered tails, missing receipts and false source/host attribution',()=>{
  const mutations=[
    ({summary})=>{summary.metrics.ingestToWake.p99Ms=100;},
    ({summary})=>{summary.metrics.measuredWallMs=1;},
    ({summary})=>{summary.metrics.measuredMatchingEventsPerSecond=4000;},
    ({raw})=>{raw.measuredDurationMs=1;},
    ({raw})=>{raw.measuredDurationMs=0;},
    ({raw})=>{raw.measuredDurationMs=Number.NaN;},
    ({raw})=>{raw.events[3].hostCallbackMs=999;},
    ({raw})=>{raw.events[1].wakeId='wake-0';},
    ({raw})=>{raw.events[1].receiptId='fake-but-unique';},
    ({raw})=>{raw.reopenedReceipts[2].receiptId='other-receipt';},
    ({raw})=>{raw.reopenedReceipts.pop();},
    ({raw})=>{raw.events[2].ingestToWakeMs=300;},
    ({raw})=>{raw.events[2].candidateDefinitions=888;},
    ({raw})=>{raw.events.pop();},
    ({raw})=>{raw.events[0].index=2;},
    ({raw})=>{raw.sourceCommitSha='another-sha';},
    ({raw})=>{raw.sourceCommitSha=null;},
    ({raw})=>{raw.providerTransportMeasured=true;},
    ({raw})=>{raw.externalHostEffectMeasured=true;},
    ({raw})=>{raw.postgresServiceCpuMeasured=true;},
    ({summary})=>{summary.evidence.persistedReceiptsCheckedAfterPoolReopen=3;},
    ({raw})=>{raw.postgres.before.xact_commit=-1;},
    ({raw})=>{raw.postgres.after.isolatedTableBytes='100';},
  ];
  for(const mutate of mutations){
    const pair=fixture(); mutate(pair);
    const verdict=verifyPostgresPipelineRawEvidence(pair.summary,pair.raw);
    assert.equal(verdict.ok,false,
      'tampered fixture was accepted');
  }
});

test('raw evidence publication is private, atomic, source-byte hashed, and never overwrites',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ei-pg-proof-'));
  const output=join(dir,'raw.json');
  try {
    const raw=Buffer.from('{"one":1.0,"two":2}\n');
    assert.notEqual(sha256OfRawEvidence(raw),
      sha256OfRawEvidence(Buffer.from('{"one":1,"two":2}\n')),
      'changed numeric text must change the raw artifact digest');
    await publishPostgresPipelineRawEvidence(output,raw);
    assert.deepEqual(await readFile(output),raw);
    assert.deepEqual(await readdir(dir),['raw.json']);
    await assert.rejects(()=>
      publishPostgresPipelineRawEvidence(output,Buffer.from('changed')),
      e=>e?.code==='EEXIST');
    assert.deepEqual(await readFile(output),raw);
    assert.deepEqual(await readdir(dir),['raw.json'],
      'failed exclusive publish must remove its random staging file');
  } finally {await rm(dir,{recursive:true,force:true});}
});
