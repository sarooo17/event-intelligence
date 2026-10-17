import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_SCALE_PROFILES = Object.freeze({
  '1k':1000,'10k':10000,'100k':100000,
});

function validLatency(value) {
  return value && Number.isInteger(value.samples) && value.samples>0 &&
    ['p50Ms','p95Ms','p99Ms','maxMs','meanMs'].every(field=>
      typeof value[field]==='number' &&
      Number.isFinite(value[field]) && value[field]>=0) &&
    value.p50Ms<=value.p95Ms && value.p95Ms<=value.p99Ms &&
    value.p99Ms<=value.maxMs;
}

function validateRun(record){
  if(!record || record.schema!=='event-intelligence.postgres-durable-scale.v1' ||
     record.status!=='completed' || !Object.hasOwn(REQUIRED_SCALE_PROFILES,record.profile) ||
     record.triggerCount!==REQUIRED_SCALE_PROFILES[record.profile] ||
     record.metrics?.listAll?.durableRowsVerified!==record.triggerCount ||
     !Number.isInteger(record.wakes) || record.wakes<1 ||
     !validLatency(record.metrics?.register?.latency) ||
     !validLatency(record.metrics?.wakeClaim) ||
     !validLatency(record.metrics?.wakeComplete) ||
     !Number.isFinite(record.metrics?.storageTotalBytes) ||
     record.metrics.storageTotalBytes<=0 ||
     !Number.isFinite(record.metrics?.register?.triggersPerSecond) ||
     record.metrics.register.triggersPerSecond<=0 ||
     typeof record.runtime?.postgresVersion!=='string' ||
     typeof record.runtime?.node!=='string') {
    const error=new Error('Invalid or incomplete actual PostgreSQL benchmark result');
    error.code='EI_PG_SCALE_EVIDENCE_INVALID';
    throw error;
  }
  return record;
}

/**
 * Aggregates only *actual* successful PG benchmark outputs. It cannot
 * fabricate missing 1k/10k/100k profiles or infer any production SLO.
 */
export function summarizeScaleEvidence(records){
  if(!Array.isArray(records))throw new TypeError('records must be an array');
  const observed={};
  const commits=new Set();
  for(const raw of records){
    const row=validateRun(raw);
    if(observed[row.profile]){
      const error=new Error('Duplicate profile '+row.profile);
      error.code='EI_PG_SCALE_EVIDENCE_DUPLICATE';
      throw error;
    }
    observed[row.profile]={
      triggers:row.triggerCount,
      wakeCycles:row.wakes,
      registerP95Ms:row.metrics.register.latency.p95Ms,
      registerThroughputPerSecond:row.metrics.register.triggersPerSecond,
      wakeClaimP95Ms:row.metrics.wakeClaim.p95Ms,
      wakeCompleteP95Ms:row.metrics.wakeComplete.p95Ms,
      storageTotalBytes:row.metrics.storageTotalBytes,
      node:row.runtime.node,
      postgresVersion:row.runtime.postgresVersion,
      commit:row.runtime.commit??null,
    };
    if(row.runtime.commit) commits.add(row.runtime.commit);
  }
  const missing=Object.keys(REQUIRED_SCALE_PROFILES)
    .filter(profile=>!observed[profile]);
  const provenanceComplete=Object.values(observed).length>0 &&
    Object.values(observed).every(row=>typeof row.commit==='string' &&
      /^[0-9a-f]{40}$/.test(row.commit)) && commits.size===1;
  const environmentsComparable=Object.values(observed).length>0 &&
    new Set(Object.values(observed).map(row=>
      row.node+'|'+row.postgresVersion)).size===1;
  return Object.freeze({
    schema:'event-intelligence.postgres-scale-matrix.v1',
    status:missing.length?'incomplete-profiles':
      !provenanceComplete || !environmentsComparable
        ? 'incomplete-provenance':'profiles-observed',
    observed,missing,
    provenanceComplete,environmentsComparable,
    productionSloCertified:false,
    caveat:'Only durable register/list/wake operations measured; no E2E provider-to-match latency, network chaos, physical CPU/RAM equivalence or automatically inferred production capacity. Hardware logs must be retained alongside raw results.',
  });
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(!args.length || args.some(arg=>arg.startsWith('--'))) {
    console.error('Usage: node scripts/evidence/postgres-scale-matrix.mjs <one or more actual benchmark-result.json files>');
    process.exitCode=2;
  } else {
    try{
      const data=args.map(file=>JSON.parse(readFileSync(file,'utf8')));
      process.stdout.write(JSON.stringify(summarizeScaleEvidence(data),null,2)+'\n');
    }catch(error){
      // Never render arbitrary DB credentials from untrusted benchmark errors.
      console.error(error.code??'EI_PG_SCALE_EVIDENCE_INVALID');
      process.exitCode=1;
    }
  }
}
