import { createHash, randomUUID } from 'node:crypto';
import { open, link, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export const PG_PIPELINE_RAW_SCHEMA = 'event-intelligence.postgres-pipeline-raw-samples.v1';
const metrics = Object.freeze([
  ['ingestToMatch', 'ingestToMatchMs'],
  ['matchToWake', 'matchToWakeMs'],
  ['ingestToWake', 'ingestToWakeMs'],
  ['hostCallback', 'hostCallbackMs'],
]);
const near = (a,b) => typeof a==='number' && typeof b==='number' &&
  Number.isFinite(a) && Number.isFinite(b) &&
  Math.abs(a-b) <= Math.max(1e-7,Math.abs(b)*1e-9);
function quantiles(values) {
  if (!values.length || values.some(v => typeof v!=='number' ||
      !Number.isFinite(v) || v<0)) return null;
  const a=[...values].sort((x,y)=>x-y);
  const q=p=>a[Math.min(a.length-1,Math.ceil(p*a.length)-1)];
  return {samples:a.length,p50Ms:q(0.5),p95Ms:q(0.95),p99Ms:q(0.99),
    maxMs:a.at(-1)};
}
/**
 * Independent recomputation of actual per-event timings, identities and
 * reported aggregate percentiles. It does NOT certify provider/network SLO.
 */
export function verifyPostgresPipelineRawEvidence(summary,raw) {
  const failures=[];
  const check=(condition,code)=>{if(!condition)failures.push(code);};
  check(raw?.schema===PG_PIPELINE_RAW_SCHEMA,'schema');
  check(summary?.schema==='event-intelligence.postgres-mcp-ingest-wake.v1' &&
    summary?.status==='completed','summary');
  const rows=Array.isArray(raw?.events)?raw.events:[];
  const count=summary?.workload?.matchingMcpOccurrences;
  check(Number.isSafeInteger(count) && count>0 && count<=5000 &&
    rows.length===count,'sample-count');
  check(raw?.scopeId && typeof raw.scopeId==='string','scope');
  check(typeof raw?.sourceCommitSha==='string' &&
    /^[0-9a-f]{40}$/.test(raw.sourceCommitSha) &&
    raw.sourceCommitSha===summary?.runtime?.commit,'source-commit');
  check(raw?.measurementKind==='in-process-synthetic-source-and-local-host',
    'scope-must-not-claim-remote-transport');
  check(raw?.providerTransportMeasured===false &&
    raw?.externalHostEffectMeasured===false &&
    raw?.postgresServiceCpuMeasured===false &&
    summary?.evidence?.transportLatencyIncluded===false &&
    summary?.evidence?.hostExecutionLatencyIncluded===false,
    'unsupported-production-attribution');
  const matches=new Set(),wakes=new Set(),receipts=new Set();
  for(let i=0;i<rows.length;i++) {
    const row=rows[i];
    check(row?.index===i,'index:'+i);
    for(const field of ['matchId','wakeId','receiptId']) {
      check(typeof row?.[field]==='string' && !!row[field],
        'missing-'+field+':'+i);
    }
    if(typeof row?.matchId==='string') matches.add(row.matchId);
    if(typeof row?.wakeId==='string') wakes.add(row.wakeId);
    if(typeof row?.receiptId==='string') receipts.add(row.receiptId);
    check(Number.isSafeInteger(row?.candidateDefinitions) &&
      row.candidateDefinitions>=0,'candidate-count:'+i);
    check(Number.isSafeInteger(row?.slot) && row.slot>=0 &&
      row.slot<summary?.workload?.triggers,'slot:'+i);
    check(near(row?.ingestToMatchMs+row?.matchToWakeMs,
      row?.ingestToWakeMs),'stage-conservation:'+i);
  }
  check(matches.size===count && wakes.size===count &&
    receipts.size===count,'unique-durable-identity-count');
  // Separate proof collected from a freshly reopened PostgreSQL pool.
  // A unique receipt string in the original event is not proof of durable
  // storage. Compare every id/status/claim generation against those reads.
  const reread=Array.isArray(raw?.reopenedReceipts)?raw.reopenedReceipts:[];
  check(reread.length===count,'reopened-receipt-count');
  for(let i=0;i<rows.length;i++) {
    const saved=reread[i],sample=rows[i];
    check(saved?.wakeId===sample?.wakeId &&
      saved?.receiptId===sample?.receiptId &&
      saved?.status==='delivered' &&
      saved?.attemptCount===1,'reopened-receipt:'+i);
  }
  check(reopenedReceiptDigest(reread)===
    summary?.evidence?.rawSamples?.reopenedReceiptDigest,
    'reopened-receipt-digest');
  check(summary?.metrics?.matchedCount===count &&
    summary?.metrics?.durableWakeCount===count &&
    summary?.metrics?.hostSideEffects===count &&
    summary?.metrics?.duplicateHostSideEffects===0 &&
    summary?.evidence?.persistedReceiptsCheckedAfterPoolReopen===count,
    'durable-receipt-host-invariant');
  // Achieved-rate measurements must have the same measured wall-clock
  // interval as the raw per-event series. A valid-looking tail histogram
  // cannot legitimize a fabricated throughput or shortened duration.
  const duration=raw?.measuredDurationMs;
  const durationValid=typeof duration==='number' &&
    Number.isFinite(duration) && duration>0;
  check(durationValid && near(summary?.metrics?.measuredWallMs,duration),
    'measured-wall-duration');
  check(durationValid && Number.isSafeInteger(count) && count>0 &&
    near(summary?.metrics?.measuredMatchingEventsPerSecond,
      count*1000/duration),'measured-achieved-throughput');
  for(const [metric,field] of metrics) {
    const found=quantiles(rows.map(row=>row?.[field]));
    const declared=summary?.metrics?.[metric];
    check(!!found && !!declared && Object.entries(found).every(([k,v])=>
      k==='samples'?declared[k]===v:near(declared[k],v)),
      'aggregate-mismatch:'+metric);
  }
  const candidates=rows.map(row=>row?.candidateDefinitions);
  if(candidates.length && candidates.every(Number.isSafeInteger)) {
    const published=summary?.evidence?.candidateDefinitionsPerMeasuredEvent;
    check(published?.samples===count &&
      published?.min===Math.min(...candidates) &&
      published?.max===Math.max(...candidates) &&
      near(published?.average,
        candidates.reduce((n,v)=>n+v,0)/count),
      'candidate-attribution');
  }
  const pg=raw?.postgres;
  check(pg?.statement==='pg_stat_database counters are DB-wide, not EI-exclusive; PG service CPU not measured',
    'pg-scope');
  for(const name of ['before','after']) {
    const stats=pg?.[name];
    for(const field of ['xact_commit','xact_rollback','blks_read',
      'blks_hit','tup_inserted','tup_updated','tup_deleted',
      'temp_bytes','deadlocks','isolatedTableBytes']) {
      check(Number.isSafeInteger(stats?.[field]) && stats[field]>=0,
        'pg-'+name+'-'+field);
    }
  }
  return Object.freeze({ok:failures.length===0,failures:Object.freeze(failures),
    productionSloCertified:false});
}

/** Digest the exact bytes of the saved artifact, never parsed/reformatted JSON. */
export function sha256OfRawEvidence(bytes) {
  if (!Buffer.isBuffer(bytes) && typeof bytes!=='string') {
    throw new TypeError('Raw evidence digest requires saved bytes or text');
  }
  return createHash('sha256').update(bytes).digest('hex');
}
export function reopenedReceiptDigest(receipts) {
  return createHash('sha256').update(JSON.stringify(receipts)).digest('hex');
}

/** Private, exclusive and POSIX crash-durable publication. */
export async function publishPostgresPipelineRawEvidence(destination,bytes) {
  if(typeof destination!=='string' || !destination.trim() ||
    !Buffer.isBuffer(bytes) || !bytes.length) {
    throw new TypeError('A fresh evidence path and raw Buffer are required');
  }
  const staging=destination+'.partial-'+randomUUID();
  let file=null,published=false;
  try {
    file=await open(staging,'wx',0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file=null;
    await link(staging,destination); // EEXIST always fails, no replacement
    published=true;
    await rm(staging);
    const dir=await open(dirname(destination),'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch(error) {
    if(published) {
      try {
        await rm(destination,{force:true});
        const dir=await open(dirname(destination),'r');
        try { await dir.sync(); } finally { await dir.close(); }
      } catch { /* Preserve original failure; operation did NOT succeed. */ }
    }
    throw error;
  } finally {
    if(file)await file.close();
    await rm(staging,{force:true});
  }
}
