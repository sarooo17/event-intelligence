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
    " 'name','noise','occurredAt',$4::text,'data',jsonb_build_object('token','NOISE_SECRET')),"+
    " 'directParents',jsonb_build_array(),'rootEvidence',jsonb_build_array())"+
    ' FROM generate_series($5::int,$6::int) n ON CONFLICT DO NOTHING',
    ['benchmark','derived_event','temporal_deadline',at,from,to]);
}
// Real same-trigger matches exercise the strict latest-match LIMIT N+1
// boundary, not merely unrelated deadline/derived rows. Each record is
// compact but structurally valid persisted match data in the PG16 store.
async function seedSameTriggerMatches(from,to){
  await pool.query(
    'INSERT INTO '+db.records+' (scope_id,kind,record_key,payload) '+
    'SELECT $1,$2,\'candidate-\'||lpad(n::text,9,\'0\'),'+
    " jsonb_build_object('protocolVersion','0.2.0',"+
    " 'schemaVersion','trigger.v0.2',"+
    " 'matchId','candidate-'||lpad(n::text,9,'0'),"+
    " 'triggerId','bench','triggerVersion','1',"+
    " 'status','partial','partitionKey',NULL,"+
    " 'openedAt',$3::text,'updatedAt',$3::text,'expiresAt',$4::text,"+
    " 'sourceEvents','[]'::jsonb,'semanticDecision',NULL,"+
    " 'firedWakeId',NULL,'derivedEventIds','[]'::jsonb)"+
    ' FROM generate_series($5::int,$6::int) n ON CONFLICT DO NOTHING',
    ['benchmark','trigger_match',at,'2026-10-29T12:01:00.000Z',from,to],
  );
}
const output={contract:'ei.inspection-high-cardinality.synthetic.v1',
  sourceCommit:process.env.BENCH_SOURCE_COMMIT??null,
  realPostgres16:true,independentHost:false,
  sourceProviderTransport:false,productionSloCertified:false,
  tiers:[],sameTriggerTiers:[],pgCandidatePlans:[],constraints:{strictWindow:8,matchBytes:65536,sourceRefs:8,
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
  // Stress a second shape: 100k MATCHING trigger/version candidates.
  // Latest-match must refuse an incomplete N+1 window before sorting;
  // an explicit matchId remains inspectable without enumerating 100k rows.
  let previousMatches=0;
  for(const count of [1000,10000,100000]){
    await seedSameTriggerMatches(previousMatches+1,count);
    previousMatches=count;
    const failedTimes=[],heaps=[];
    for(let attempt=0;attempt<12;attempt++){
      const heap=process.memoryUsage().heapUsed;
      const started=performance.now();
      let refused;
      try{
        await db.getBoundedInspectionMatch({triggerId:'bench',
          version:'1',maxCandidates:512,maxRowBytes:65536,maxScanMs:2000});
      }catch(error){refused=error;}
      const elapsed=performance.now()-started;
      assert.equal(refused?.code,
        'EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED',
        'over-cap latest selection must never manufacture a result');
      assert.match(refused.message,/cardinality/,
        'the N+1 candidate check (not SQL timeout) must reject');
      if(attempt>=2){
        failedTimes.push(elapsed);
        heaps.push(Math.max(0,process.memoryUsage().heapUsed-heap));
      }
    }
    const actual=await inspector.inspect({triggerId:'bench',
      version:'1',matchId:'selected'});
    assert.equal(actual.match.matchId,'selected',
      'bounded exact-ID route must remain available under matching load');
    assert(!JSON.stringify(actual).includes('NOISE_SECRET'));
    // A SQL-side plan gives independent physical resource evidence that
    // client-side P95 and heap deltas alone cannot supply. This is the
    // exact scope/trigger/version predicate and N+1 candidate subquery
    // from the strict selector, not a claim of whole-host SLO coverage.
    const planResult=await pool.query(
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)'+
      ' SELECT record_key,payload FROM '+db.records+
      " WHERE scope_id=$1 AND kind=$2"+
      " AND payload->>'triggerId'=$3 AND payload->>'triggerVersion'=$4"+
      ' LIMIT $5',
      ['benchmark','trigger_match','bench','1',513],
    );
    const root=planResult.rows[0]?.['QUERY PLAN']?.[0];
    assert(root?.Plan,'PG16 planner must return a real JSON plan');
    const seenNodes=[];
    function visitPlan(node){
      seenNodes.push(String(node['Node Type']));
      for(const child of node.Plans??[])visitPlan(child);
    }
    visitPlan(root.Plan);
    assert(Number.isFinite(root['Execution Time']));
    assert(root.Plan['Actual Rows']<=513);
    assert(!seenNodes.includes('Sort'),
      'N+1 preselection must not sort the unbounded trigger population');
    const metric=name=>Number(root.Plan[name]??0);
    output.pgCandidatePlans.push({
      persistedMatchingCandidates:count+1,
      mode:'scoped_candidate_limit_subquery_only',
      maxRows:513,actualRows:metric('Actual Rows'),
      executionTimeMs:Number(root['Execution Time'].toFixed(3)),
      sharedHitBlocks:metric('Shared Hit Blocks'),
      sharedReadBlocks:metric('Shared Read Blocks'),
      sharedDirtiedBlocks:metric('Shared Dirtied Blocks'),
      sharedWrittenBlocks:metric('Shared Written Blocks'),
      nodeTypes:seenNodes,
    });
    const timed=envelope(failedTimes);
    output.sameTriggerTiers.push({
      persistedMatchingCandidates:count+1,
      samples:failedTimes.length,
      latestResult:'refused_cardinality_fail_closed',
      elapsed:timed,
      maxPositiveHeapDeltaBytes:Math.max(...heaps),
      exactMatchInspectAvailable:true,
    });
    if(timed.maxMs>=2000){
      throw Error('Bounded same-trigger cardinality refusal exceeded measured 2s');
    }
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
