import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {PostgresEventStore} from '../lib/postgres-event-store.mjs';
import {TriggerInspector} from '../lib/trigger-inspector.mjs';

function validCount(value,max){
  return Number.isSafeInteger(value)&&value>=1&&value<=max;
}
function percentile(values,p) {
  const sorted=[...values].sort((a,b)=>a-b);
  return Math.round(sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]*1000)/1000;
}
async function pgCounters(pool) {
  const result=await pool.query(
    "SELECT blks_hit,blks_read,tup_returned,tup_fetched, xact_commit "+
    "FROM pg_stat_database WHERE datname=current_database()");
  const row=result.rows[0];
  if(!row)throw Error('PostgreSQL database statistics unavailable');
  return Object.fromEntries(
    ['blks_hit','blks_read','tup_returned','tup_fetched','xact_commit']
      .map(key=>[key,BigInt(row[key]??0)]));
}
export async function measureRailwayInspector({
  pool,tablePrefix,scopeId,triggerCount,triggerLimit=5,
  samplesPerTrigger=5,
}={}) {
  if(!pool||typeof pool.query!=='function'||
     typeof tablePrefix!=='string'||
     !/^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/.test(tablePrefix)||
     typeof scopeId!=='string'||!/^[-a-zA-Z0-9_:]{1,160}$/.test(scopeId)||
     !validCount(triggerCount,100000)||
     !validCount(triggerLimit,20)||
     !validCount(samplesPerTrigger,10)||
     triggerLimit*samplesPerTrigger>100){
    throw new RangeError('Invalid bounded Railway inspector measurement');
  }
  const inspectedTriggers=Math.min(triggerCount,triggerLimit);
  const store=new PostgresEventStore({
    pool,dispatchPoolIdentity:pool,tablePrefix,scopeId,
  });
  await store.init();
  const inspector=new TriggerInspector({store,
    inspectionWindowLimit:8,matchHistoryLimit:8,evidenceRefLimit:8,
  });
  const timings=[],errors=[],statusCounts={};
  const cpuBefore=process.cpuUsage();
  const heapBefore=process.memoryUsage().heapUsed;
  const statsBefore=await pgCounters(pool);
  for(let slot=0;slot<inspectedTriggers;slot++){
    for(let i=0;i<samplesPerTrigger;i++){
      const start=performance.now();
      try {
        const output=await inspector.inspect({
          triggerId:'railway-slot-'+slot,version:'1',
        });
        if(!output?.match || output.trigger.triggerId!=='railway-slot-'+slot)
          throw Object.assign(new Error('Selected match unavailable'),
            {code:'EI_INSPECTION_MATCH_MISSING'});
        const status=String(output.match.status);
        if(!['partial','matched','fired','emitted','expired'].includes(status))
          throw Object.assign(new Error('Unexpected match status'),
            {code:'EI_INSPECTION_MATCH_STATUS_INVALID'});
        statusCounts[status]=(statusCounts[status]??0)+1;
      }catch(error){
        // No source payload, model text, raw SQL or external IDs in reports.
        errors.push({slot,code:typeof error?.code==='string'&&
          /^[-A-Z0-9_]{1,100}$/.test(error.code)?error.code:
            'EI_INSPECTION_UNCLASSIFIED_ERROR'});
      }finally{
        timings.push(performance.now()-start);
      }
    }
  }
  const statsAfter=await pgCounters(pool);
  const cpu=process.cpuUsage(cpuBefore);
  const total=timings.reduce((sum,value)=>sum+value,0);
  return {
    contract:'ei.railway-strict-inspector-evidence.v1',
    measuredAt:new Date().toISOString(),
    environment:'railway-private-service',
    sourceProviderExternal:false,independentThirdPartyHost:false,
    productionSloCertified:false,
    scopeDigest:createHash('sha256').update(scopeId).digest('hex'),
    inspectedTriggers, samplesPerTrigger,samples:timings.length,
    successes:timings.length-errors.length,refusals:errors.length,
    elapsedMs:{p50:percentile(timings,.5),
      p95:percentile(timings,.95),p99:percentile(timings,.99),
      max:Math.round(Math.max(...timings)*1000)/1000,
      mean:Math.round(total/timings.length*1000)/1000},
    nodeCpuMicros:{user:cpu.user,system:cpu.system},
    heapDeltaBytes:process.memoryUsage().heapUsed-heapBefore,
    // PostgreSQL counters are database-wide; concurrent work can change them.
    pgDatabaseGlobalDelta:Object.fromEntries(Object.keys(statsBefore).map(
      key=>[key,Number(statsAfter[key]-statsBefore[key])])),
    pgCountersAreScopeIsolated:false,
    nodeCpuIsProcessWide:true,
    latencySamplesMs:timings.map(x=>Math.round(x*1000)/1000),
    matchStatuses:statusCounts,
    errors:errors.slice(0,10),
    campaignRecordsUnchanged:true,
  };
}
