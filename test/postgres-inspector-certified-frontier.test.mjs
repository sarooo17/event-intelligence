import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
import {TriggerInspector} from '../scripts/lib/trigger-inspector.mjs';

const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const prefix='ei_cert_frontier_'+randomBytes(5).toString('hex');
const definition={
  triggerId:'release',version:'1',
  clauses:[
    {id:'merged',serverId:'git',event:'pr.merged',where:[]},
    {id:'deployed',serverId:'git',event:'deploy.ok',where:[]},
  ],
  pattern:{version:'2',root:{kind:'allOf',children:[
    {kind:'event',ref:'merged'}, {kind:'event',ref:'deployed'},
  ]}},
  withinMs:60000,target:{runtime:'host',kind:'task',id:'notify'},
};
const source={connectionId:'conn',serverId:'git',
  eventName:'deploy.ok',arguments:{}};
const partial={
  protocolVersion:'0.2.0',schemaVersion:'trigger.v0.2',
  matchId:'candidate-a',triggerId:'release',triggerVersion:'1',
  status:'partial',partitionKey:null,
  openedAt:'2026-10-29T10:00:00.000Z',
  updatedAt:'2026-10-29T10:00:01.000Z',
  expiresAt:'2026-10-29T10:01:00.000Z',
  sourceEvents:[{
    clauseId:'merged',traceId:'opaque-trace',
    sourceEventId:'merged-1',eventName:'pr.merged',
    serverId:'git',occurredAt:'2026-10-29T10:00:00.000Z',
    data:{watermarkAt:'2099-01-01T00:00:00Z',
      proofRef:'UNTRUSTED_MCP_PRIVATE_PAYLOAD'},
  }],
  semanticDecision:null,firedWakeId:null,derivedEventIds:[],
  patternState:{version:'2',role:'buffer',
    maxObservedOccurredAt:'2026-10-29T10:00:00.000Z',semanticDecisions:[]},
};
function store(pool,scope){return new PostgresEventStore({
  pool,dispatchPoolIdentity:pool,tablePrefix:prefix,scopeId:scope,
});}
async function prepare(db,owner){
  await db.init();await db.putTrigger(definition);
  await db.setTriggerState('release','1','active',null,{
    connectionIds:['conn'],
    owner:{type:'user',principal_id:owner,tenant_id:owner},
  });
  await db.putEventSource({sourceId:'deployment',...source,
    eventName:'deploy.ok',enabled:true,delivery:['poll']});
  await db.appendTriggerMatch(partial);
  await db.putMcpClientState({...source,sourceAvailability:'available'});
}
function inspector(db){return new TriggerInspector({
  store:db,inspectionWindowLimit:3,evidenceRefLimit:3,matchHistoryLimit:3,
}).inspect({triggerId:'release',version:'1',matchId:'candidate-a'});}
function certify(db,revision,through,verifyProof=async()=>true){
  return db.recordVerifiedInspectionFrontier({
    ...source,expectedCompletenessRevision:revision,
    completeThroughAt:through,proofRef:'host-verified-opaque-proof-v1',
    verifyProof,
  });
}
integration('PG16 host-verified source frontier drives only scoped, revision-current selected candidate diagnosis',async()=>{
  let pool=new Pool({connectionString:url,max:4});
  let reopened=null;
  try{
    const a=store(pool,'tenant-A'),b=store(pool,'tenant-B');
    await prepare(a,'tenant-A');await prepare(b,'tenant-B');
    assert.equal((await inspector(a)).diagnosisV2.kind,'not_yet_satisfied');
    assert.equal((await inspector(b)).diagnosisV2.kind,'not_yet_satisfied');
    const initial=await a.getMcpClientState('conn','deploy.ok',{});
    assert.equal(initial.completenessRevision,1);
    await assert.rejects(()=>certify(a,initial.completenessRevision,
      '2026-10-29T10:00:45.000Z',async()=>false),error=>
        error.code==='EVENT_INTELLIGENCE_UNVERIFIED_SOURCE_FRONTIER');
    await certify(a,1,'2026-10-29T10:00:45.000Z',async proof=>{
      assert.equal(proof.eventName,'deploy.ok');
      assert.equal(proof.scopeId,'tenant-A');
      assert.equal(proof.argumentsCanonical,'{}');
      assert.match(proof.sourceKeyDigest,/^[a-f0-9]{64}$/);
      assert.equal(proof.completenessRevision,1);
      assert.equal(proof.proofRef,'host-verified-opaque-proof-v1');
      return true;
    });
    const pending=await inspector(a);
    assert.equal(pending.diagnosisV2.kind,'watermark_pending');
    assert.equal(pending.diagnosisV2.upstreamCompleteness,'unknown');
    assert.equal(JSON.stringify(pending).includes('UNTRUSTED_MCP_PRIVATE_PAYLOAD'),false);
    assert.equal(JSON.stringify(pending).includes('host-verified-opaque-proof'),false);
    assert.equal((await inspector(b)).diagnosisV2.kind,'not_yet_satisfied',
      'foreign tenant with same IDs cannot access certified frontier');

    // A live buffer may receive a second eligible anchor before expiry.
    // The first anchor's expiresAt cannot prove the entire buffer impossible.
    const secondAnchor={...partial.sourceEvents[0],
      sourceEventId:'merged-2',occurredAt:'2026-10-29T10:00:50.000Z'};
    await a.appendTriggerMatch({...partial,
      updatedAt:'2026-10-29T10:00:52.000Z',
      sourceEvents:[...partial.sourceEvents,secondAnchor],
      patternState:{...partial.patternState,
        maxObservedOccurredAt:'2026-10-29T10:00:50.000Z'}});
    assert.equal((await inspector(a)).diagnosisV2.kind,'watermark_pending');

    // A healthy poll advances source revision. Its previous certificate
    // cannot be replayed to prove terminal impossibility or new progress.
    await a.putMcpClientState({...source,sourceAvailability:'available'});
    assert.equal((await inspector(a)).diagnosisV2.kind,'not_yet_satisfied');
    await assert.rejects(()=>certify(a,1,'2026-10-29T10:02:00.000Z'),
      error=>error.code==='EVENT_INTELLIGENCE_STALE_SOURCE_FRONTIER');
    const current=await a.getMcpClientState('conn','deploy.ok',{});
    await certify(a,current.completenessRevision,'2026-10-29T10:01:10.000Z');
    assert.equal((await inspector(a)).diagnosisV2.kind,'watermark_pending',
      'first-anchor expiry 10:01:00 cannot terminate second anchor at 10:00:50');
    await certify(a,current.completenessRevision,'2026-10-29T10:02:00.000Z');
    const impossible=await inspector(a);
    assert.equal(impossible.diagnosisV2.kind,'candidate_impossible');
    assert.equal(impossible.diagnosisV2.scope,'selected_match');
    assert.equal(impossible.diagnosisV2.upstreamCompleteness,'unknown',
      'terminal selected candidate is not universal upstream finality');
    await assert.rejects(()=>certify(a,current.completenessRevision,
      '2026-10-29T09:58:00.000Z'),error=>
        error.code==='EVENT_INTELLIGENCE_SOURCE_FRONTIER_REGRESSION');

    // No mixture of independently valid frontiers is accepted: the
    // entire requested source set must validate under a single scope fence.
    assert.equal(await a.getVerifiedInspectionFrontiers([
      source,{connectionId:'missing',serverId:'git',eventName:'deploy.ok',arguments:{}},
    ]),null);

    // Strict inspection must not wait without bound on a stalled host poll
    // holding the scope completeness advisory lock.
    const holder=await pool.connect();
    try{
      await holder.query('BEGIN');
      await holder.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [prefix+':tenant-A:mcp-gap-fence:scope']);
      await assert.rejects(()=>a.getVerifiedInspectionFrontiers([
        source,
      ],{maxScanMs:150}),error=>
        error.code==='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED');
    }finally{
      await holder.query('ROLLBACK');
      holder.release();
    }

    await pool.end();
    reopened=new Pool({connectionString:url,max:4});
    const restored=store(reopened,'tenant-A');
    await restored.init();
    assert.equal((await inspector(restored)).diagnosisV2.kind,'candidate_impossible',
      'trusted scoped frontier evidence must survive fresh PG pool');

    await restored.putMcpClientState({...source,truncated:true});
    assert.equal((await inspector(restored)).diagnosisV2.kind,
      'source_gap_unresolved','new gap invalidates previous terminal frontier');
    assert.equal((await inspector(store(reopened,'tenant-B'))).diagnosisV2.kind,
      'not_yet_satisfied');
  }finally{
    const cleanup=reopened??pool;
    for(const suffix of ['metadata','leases','history','records','counters']){
      await cleanup.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    }
    await cleanup.end();
  }
});

test('host certification does not infer provider completeness from event timestamps',async()=>{
  const {persistedGapInspectionFact} = await import(
    '../scripts/lib/inspection-persisted-mcp-gap.mjs');
  const s={
    getTrigger:()=>definition,
    getTriggerState:()=>({connectionIds:['conn']}),
    listEventSources:()=>[{...source,enabled:true}],
    getMcpClientState:()=>({connectionId:'conn',serverId:'git',
      eventName:'deploy.ok',sourceAvailability:'available',completenessRevision:1}),
    getTriggerMatch:()=>partial,
    getVerifiedInspectionFrontier:()=>null,
  };
  assert.equal(await persistedGapInspectionFact(s,{
    triggerId:'release',triggerVersion:'1',matchId:'candidate-a'}),null);
  // A forged watermark inside source event data cannot become a store proof.
  assert.equal(partial.sourceEvents[0].data.watermarkAt,'2099-01-01T00:00:00Z');
});
