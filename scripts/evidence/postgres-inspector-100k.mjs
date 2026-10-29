import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {Pool} from 'pg';
import {PostgresEventStore} from '../lib/postgres-event-store.mjs';
import {TriggerInspector} from '../lib/trigger-inspector.mjs';

if(process.env.EI_INSPECT_BENCH_CONFIRM!=='YES_ISOLATED' ||
   typeof process.env.POSTGRES_URL!=='string' ||
   !process.env.POSTGRES_URL) throw Error('An explicitly isolated PostgreSQL16 DSN and confirmation are required');
const prefix='ei_insp_bench_'+randomBytes(6).toString('hex');
const pool=new Pool({connectionString:process.env.POSTGRES_URL,max:5});
const db=new PostgresEventStore({
  pool,dispatchPoolIdentity:pool,tablePrefix:prefix,scopeId:'benchmark',
});
const definition={
  triggerId:'bench',version:'1',clauses:[{id:'a',serverId:'source',event:'changed',where:[]}],
  pattern:{version:'2',root:{kind:'event',ref:'a'}},
  withinMs:60000,target:{runtime:'host',kind:'task',id:'x'},
};
const at='2026-10-29T12:00:00.000Z';
const currentMatch={
  protocolVersion:'0.2.0',schemaVersion:'trigger.v0.2',
  matchId:'selected',triggerId:'bench',triggerVersion:'1',status:'partial',
  openedAt:at,updatedAt:at,expiresAt:'2026-10-29T12:01:00.000Z',
  partitionKey:null,sourceEvents:[],
  derivedEventIds:[],firedWakeId:null,semanticDecision:null,
};
function percentile(data,p){
  const ordered=[...data].sort((a,b)=>a-b);
  return Number(ordered[Math.min(ordered.length-1,Math.ceil(p*ordered.length)-1)].toFixed(3));
}
function envelope(values){
  return {count:values.length,p50Ms:percentile(values,.5),
    p95Ms:percentile(values,.95),p99Ms:percentile(values,.99),
    maxMs:Number(Math.max(...values).toFixed(3))};
}
async function seed(to,from){
  await pool.query(
    'INSERT INTO '+db.records+' (scope_id,kind,record_key,payload) '+
    'SELECT $1, CASE WHEN n%2=0 THEN $2 ELSE $3 END,'+
    " 'noise-'||lpad(n::text,9,'0'),"+
    " jsonb_build_object('triggerId','bench','matchId','noise-'||n::text,"+
    " 'status','pending','event',jsonb_build_object('sourceEventId','n'||n::text,"+
    " 'name','noise','occurredAt',$4,'data',jsonb_build_object('token','NOISE_SECRET')),"+
    " 'directParents',jsonb_build_array(),'rootEvidence',jsonb_build_array())"+
    ' FROM generate_series($5::int,$6::int) n ON CONFLICT DO NOTHING',
    ['benchmark','derived_event','temporal_deadline',at,from,to]);
}
const output={contract:'ei.inspection-high-cardinality.synthetic.v1',
  sourceCommit:process.env.BENCH_SOURCE_COMMIT??null,
  realPostgres16:true,independentHost:false,
  sourceProviderTransport:false,productionSloCertified:false,
  tiers:[],constraints:{strictWindow:8,matchBytes:65536,sourceRefs:8,
    history:8,deadlineDerivedRowBytes:16384,statementTimeoutMs:2000}};
try{
  await db.init();
  await db.putTrigger(definition);
  await db.appendTriggerMatch(currentMatch);
  for(let i=0;i<4;i++){
    await db.putTemporalDeadline({deadlineId:'target-d-'+i,
      triggerId:'bench',matchId:'selected',conditionId:'a',
      dueAt:'2026-10-29T12:00:30.000Z',status:'pending'});
    await db.upsert('derived_event','target-e-'+i,{
      triggerId:'bench',matchId:'selected',
      event:{sourceEventId:'e'+i,name:'derived',occurredAt:at,data:{}},
      directParents:[],rootEvidence:[],
    });
  }
  const inspector=new TriggerInspector({
    store:db,inspectionWindowLimit:8,evidenceRefLimit:8,matchHistoryLimit:8,
  });
  let current=0;
  for(const count of [1000,10000,100000]){
    await seed(count,current+1);
    current=count;
    const measures=[],mem=[];
    for(let i=0;i<40;i++){
      const before=process.memoryUsage().heapUsed;
      const start=performance.now();
      const view=await inspector.inspect({
        triggerId:'bench',version:'1',matchId:'selected'});
      const elapsed=performance.now()-start;
      if(i>=5){measures.push(elapsed);
        mem.push(Math.max(0,process.memoryUsage().heapUsed-before));}
      assert.equal(view.evidenceSummary.pendingDeadlineCount,4);
      assert.equal(view.lineage.derivedOutputs.length,4);
      assert.equal(view.match.matchId,'selected');
      assert.equal(view.evidenceSummary.inspectionWindowLimit,8);
      assert(!JSON.stringify(view).includes('NOISE_SECRET'));
    }
    const timings=envelope(measures);
    output.tiers.push({persistedNoiseRows:count,
      inspectorCalls:measures.length,elapsed:timings,
      maxPositiveHeapDeltaBytes:Math.max(...mem),identityVerified:true});
    if(timings.maxMs>=2000)throw Error('Inspection strict-mode end-to-end latency exceeded measured 2s ceiling');
  }
  output.completed=true;
  process.stdout.write(JSON.stringify(output,null,2)+'\n');
}catch(e){
  process.stderr.write(JSON.stringify({code:e.code??'EI_INSPECTION_EVIDENCE_FAILED',
    message:String(e.message).slice(0,280)})+'\n');
  process.exitCode=1;
}finally{
  for(const suffix of ['metadata','leases','history','records','counters']){
    await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
  }
  await pool.end();
}
