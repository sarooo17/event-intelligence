import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
import {verifyPostgresV1NoPruneRetention} from
  '../scripts/validation/postgres-no-prune-retention-v1.mjs';

const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const at='2026-10-05T10:00:00.000Z';
const before='2026-10-10T00:00:00.000Z';
const event=id=>({eventId:id,name:'fixture.source.updated',timestamp:at,
  data:{id,secret:'never-in-report'}});
const match=(id,status='fired')=>({
  protocolVersion:'0.2.0',schemaVersion:'trigger.v0.2',
  matchId:id,triggerId:'no-prune-trigger',triggerVersion:'1',
  status,partitionKey:null,openedAt:at,updatedAt:at,
  expiresAt:'2026-10-05T10:01:00.000Z',sourceEvents:[],
  semanticDecision:null,
  patternState:{version:'2',role:'match',signature:id,semanticDecisions:[]},
  firedWakeId:status==='fired'?'wake-'+id:null,derivedEventIds:[],
});
const wake=(id,status='delivered')=>({
  wakeId:id,traceId:'v1-retention-trace',decisionId:null,
  subscriptionId:'trigger:no-prune-trigger',sourceEventId:'match-'+id,
  createdAt:at,status,target:{runtime:'fixture-host',kind:'task',id},
});
const mk=(pool,prefix,scope)=>new PostgresEventStore({pool,scopeId:scope,
  tablePrefix:prefix,dispatchPoolIdentity:pool});
const cleanup=async(pool,prefix)=>{
  for(const table of ['metadata','leases','history','records','counters'])
    await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+table+'" CASCADE');
};

integration('PG16 v1 no-prune: scoped source+dedup+audit survive real terminal compaction and restarted PG pools',async()=>{
  const prefix='ei_v1_noprune_'+randomBytes(5).toString('hex');
  const aPool=new Pool({connectionString:url,max:3});
  const bPool=new Pool({connectionString:url,max:3});
  let restarted=null;
  const a=mk(aPool,prefix,'v1-A'),peer=mk(bPool,prefix,'v1-A');
  const foreign=mk(bPool,prefix,'v1-B');
  try{
    await Promise.all([a.init(),peer.init(),foreign.init()]);
    await a.putMcpClientState({connectionId:'source-conn',
      serverId:'source',eventName:'fixture.source.updated',
      arguments:{project:'private-scope'},cursor:'opaque-private-cursor',
      deliveryMode:'poll',truncated:false});
    for(let i=0;i<3;i++)await (i%2?peer:a).appendMcpOccurrence(
      'fixture-source',event('A-'+i),'subscription-A');
    await foreign.appendMcpOccurrence('fixture-source',event('B-0'),
      'subscription-B');
    for(let i=0;i<2;i++)await a.appendAudit({
      auditId:'v1-audit-'+i,traceId:'v1-retention-trace',timestamp:at,
      kind:'trigger.created',entityType:'trigger',
      entityId:'no-prune-trigger',details:{revision:i},
    });
    for(let i=0;i<5;i++)await a.appendTriggerMatch(match('fired'));
    for(let i=0;i<5;i++)await a.appendTriggerMatch(match('active','matched'));
    for(let i=0;i<5;i++)await a.appendWake(wake('wake-fired'));
    for(let i=0;i<5;i++)await a.appendWake(wake('wake-pending','queued'));
    await a.ensureWakeDelivery({wakeId:'wake-fired',matchId:'fired',
      triggerId:'no-prune-trigger',triggerVersion:'1',
      runtime:'fixture-host',now:at});
    const claim=await a.claimWakeDelivery('wake-fired',{
      workerId:'host-a',now:at,leaseMs:1000});
    assert(claim);
    await a.completeWakeDelivery('wake-fired',{workerId:'host-a',
      attemptCount:claim.attemptCount,runtimeReceiptId:'host:durable-1',
      now:'2026-10-05T10:00:00.500Z'});
    await a.ensureWakeDelivery({wakeId:'wake-pending',matchId:'active',
      triggerId:'no-prune-trigger',triggerVersion:'1',
      runtime:'fixture-host',now:at});
    const sourceBefore=await a.listMcpOccurrencesAfter(0);
    const sourceCheckpoint=await a.getMcpOccurrenceArchiveCheckpoint();
    const auditBefore=await a.listAudit();
    const auditCheckpoint=await a.getAuditCheckpoint();
    const receiptBefore=await a.getWakeDelivery('wake-fired');
    const base=await verifyPostgresV1NoPruneRetention({
      store:peer,matchIds:['fired','active'],
      wakeIds:['wake-fired','wake-pending']});
    assert.equal(base.sourceTailSequence,3);
    assert.equal(base.auditEndSequence,1);
    assert.equal(base.sourcePruneAuthorized,false);
    assert.equal(base.auditPruneAuthorized,false);
    assert.equal(base.receiptPruneAuthorized,false);
    assert.equal(base.providerCompletenessCertified,false);
    assert.equal(base.archiveBackedReplayFloorEstablished,false);
    assert.equal(JSON.stringify(base).includes('opaque-private-cursor'),false);
    assert.equal(JSON.stringify(base).includes('never-in-report'),false);
    const history='"'+prefix+'_history"';
    // The operator maxScanMs must apply to the actual long-running source
    // history SELECT and full audit checkpoint advisory lock, not only to
    // the preliminary inventory. No source/audit/wake deletion occurs.
    const sourceHolder=await bPool.connect();
    try{
      await sourceHolder.query('BEGIN');
      await sourceHolder.query('LOCK TABLE '+history+
        ' IN ACCESS EXCLUSIVE MODE');
      await assert.rejects(()=>a.listMcpOccurrencesAfter(0,{maxScanMs:150}),
        e=>e.code==='57014','source replay actual history SELECT bounded');
      await assert.rejects(()=>a.auditLength({maxScanMs:150}),
        e=>e.code==='57014','initial audit count SQL also bounded');
      await assert.rejects(()=>verifyPostgresV1NoPruneRetention({
        store:a,maxScanMs:150}),
        e=>e.code==='57014','complete preflight must not wait on history lock');
    }finally{
      await sourceHolder.query('ROLLBACK');
      sourceHolder.release();
    }
    const auditHolder=await bPool.connect();
    try{
      await auditHolder.query('BEGIN');
      await auditHolder.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [prefix+':v1-A:audit:chain']);
      await assert.rejects(()=>a.getAuditCheckpoint({maxScanMs:150}),
        e=>e.code==='57014','audit checkpoint advisory lock bounded');
      await assert.rejects(()=>verifyPostgresV1NoPruneRetention({
        store:a,maxScanMs:150}),
        e=>e.code==='57014','blocked audit lock must fail within budget');
    }finally{
      await auditHolder.query('ROLLBACK');
      auditHolder.release();
    }
    assert.equal((await verifyPostgresV1NoPruneRetention({store:a}))
      .sourceTailSequence,3);

    await aPool.query('UPDATE '+history+
      ' SET created_at=$1::timestamptz WHERE scope_id=$2 AND kind=ANY($3)',
      ['2026-10-08T10:00:00.000Z','v1-A',
        ['wake','trigger_match_history']]);
    await assert.rejects(()=>a.compactScopedTerminalHistoryBatch({
      kind:'audit',before,dryRun:false}),
      e=>e.code==='EVENT_INTELLIGENCE_TERMINAL_SWEEP_POLICY_INVALID');
    await assert.rejects(()=>a.compactScopedTerminalHistoryBatch({
      kind:'mcp_occurrence',before,dryRun:false}),
      e=>e.code==='EVENT_INTELLIGENCE_TERMINAL_SWEEP_POLICY_INVALID');
    const matches=await peer.compactScopedTerminalHistoryBatch({
      kind:'trigger_match_history',before,maxKeys:4,dryRun:false});
    assert.equal(matches.deleted,3);
    assert.equal(matches.rows.find(r=>r.key==='active')?.skipped,'not_fired');
    const wakes=await a.compactScopedTerminalHistoryBatch({
      kind:'wake',before,maxKeys:4,dryRun:false});
    assert.equal(wakes.deleted,3);
    assert.equal(wakes.rows.find(r=>r.key==='wake-pending')?.skipped,
      'not_durably_delivered');
    assert.equal((await peer.listTriggerMatchHistory('fired')).length,2);
    assert.equal((await peer.listTriggerMatchHistory('active')).length,5);
    assert.equal((await peer.getWakeDelivery('wake-pending')).status,'pending');
    assert.deepEqual(await peer.listMcpOccurrencesAfter(0),sourceBefore);
    assert.deepEqual(await peer.getMcpOccurrenceArchiveCheckpoint(),
      sourceCheckpoint);
    assert.deepEqual(await peer.listAudit(),auditBefore);
    assert.deepEqual(await peer.getAuditCheckpoint(),auditCheckpoint);
    assert.equal(await peer.verifyAudit(),true);
    assert.deepEqual(await peer.getWakeDelivery('wake-fired'),receiptBefore);
    assert.equal(await peer.claimWakeDelivery('wake-fired',{
      workerId:'late-replay',now:'2026-10-05T11:00:00.000Z'}),null);
    assert.equal((await foreign.listMcpOccurrencesAfter(0)).length,1);
    await aPool.end();
    restarted=new Pool({connectionString:url,max:3});
    const cold=mk(restarted,prefix,'v1-A');
    await cold.init();
    const proof=await verifyPostgresV1NoPruneRetention({
      store:cold,matchIds:['fired','active'],
      wakeIds:['wake-fired','wake-pending']});
    assert.deepEqual(proof.matches.map(x=>x.revisions),[2,5]);
    assert.equal(proof.wakes[0].receiptPresent,true);
    assert.equal(proof.wakes[1].receiptPresent,false);
    assert.equal(proof.sourceHeadHash,sourceCheckpoint.headHash);
    assert.equal(proof.auditHeadHash,auditCheckpoint.headHash);
    assert.deepEqual(await cold.listMcpOccurrencesAfter(2),
      sourceBefore.slice(2));
    const duplicate=await cold.appendMcpOccurrence('fixture-source',
      event('A-0'),'subscription-A');
    assert.equal(duplicate.accepted,false);
    assert.equal(duplicate.sequence,1);
    assert.equal(await cold.latestMcpEventSequence(),3);
    assert.equal(await cold.claimWakeDelivery('wake-fired',{
      workerId:'late-after-restart',now:'2026-10-05T11:00:00.000Z'}),null);
    assert.deepEqual(await cold.getWakeDelivery('wake-fired'),receiptBefore);
    assert.equal((await cold.verifyAudit()),true);
    // A real provider-state gap cannot become a source retention/prune
    // authorization; source history remains locally intact while
    // upstream completeness stays explicitly unknown.
    await cold.putMcpClientState({connectionId:'source-conn',
      serverId:'source',eventName:'fixture.source.updated',
      arguments:{project:'private-scope'},cursor:'opaque-private-cursor',
      deliveryMode:'poll',truncated:true});
    const gap=await verifyPostgresV1NoPruneRetention({store:cold});
    assert.equal(gap.sourceDeliveryGapsObserved,true);
    assert.equal(gap.providerCompletenessCertified,false);
    assert.equal(gap.sourcePruneAuthorized,false);
    assert.deepEqual(await cold.listMcpOccurrencesAfter(0),sourceBefore);
    await assert.rejects(()=>verifyPostgresV1NoPruneRetention({
      store:cold,maxOccurrences:2}),
      e=>e.code==='EVENT_INTELLIGENCE_V1_RETENTION_BUDGET_EXCEEDED');
    await assert.rejects(()=>verifyPostgresV1NoPruneRetention({
      store:cold,matchIds:Array(101).fill('unsafe')}),
      e=>e.code==='EVENT_INTELLIGENCE_V1_RETENTION_POLICY_INVALID');
  }finally{
    try{await cleanup(bPool,prefix)}finally{
      await Promise.allSettled([aPool.end(),bPool.end(),restarted?.end()]);
    }
  }
});

integration('PG16 no-prune fails closed after missing source, lost dedup or truncated audit prefix; other tenant unaffected',async()=>{
  const prefix='ei_v1_retention_fault_'+randomBytes(5).toString('hex');
  const poolA=new Pool({connectionString:url,max:3});
  const poolB=new Pool({connectionString:url,max:3});
  const a=mk(poolA,prefix,'damaged-source');
  const b=mk(poolB,prefix,'damaged-dedup');
  const c=mk(poolB,prefix,'damaged-audit');
  const d=mk(poolB,prefix,'damaged-wake');
  const good=mk(poolA,prefix,'healthy-other-tenant');
  try{
    await Promise.all([a.init(),b.init(),c.init(),d.init(),good.init()]);
    for(const st of [a,b,c,good]){
      for(let i=0;i<2;i++)await st.appendMcpOccurrence(
        'remote',event(st.scopeId+'-'+i),'subscription');
      for(let i=0;i<2;i++)await st.appendAudit({
        auditId:'audit-'+st.scopeId+'-'+i,
        traceId:'v1-trace',timestamp:at,kind:'trigger.created',
        entityType:'trigger',entityId:'fixture',details:{i}});
    }
    const history='"'+prefix+'_history"',records='"'+prefix+'_records"';
    await poolA.query('DELETE FROM '+history+
      " WHERE scope_id=$1 AND kind='mcp_occurrence'"+
      " AND payload->>'sequence'='1'",[a.scopeId]);
    await poolB.query('DELETE FROM '+records+
      " WHERE scope_id=$1 AND kind='mcp_occurrence_key'"+
      " AND payload->>'sequence'='1'",[b.scopeId]);
    await poolA.query('DELETE FROM '+history+
      " WHERE scope_id=$1 AND kind='audit'"+
      " AND payload->>'sequence'='0'",[c.scopeId]);
    await assert.rejects(()=>verifyPostgresV1NoPruneRetention({store:a}),
      e=>e.code==='EVENT_INTELLIGENCE_MCP_REPLAY_HISTORY_GAP');
    await assert.rejects(()=>verifyPostgresV1NoPruneRetention({store:b}),
      e=>e.code==='EVENT_INTELLIGENCE_MCP_REPLAY_HISTORY_GAP');
    await assert.rejects(()=>verifyPostgresV1NoPruneRetention({store:c}));
    await assert.rejects(()=>c.getAuditCheckpoint());
    // A durable wake_delivery without its source wake-history witness must
    // not appear fully provenance-preserved after a manual SQL deletion.
    await d.appendWake(wake('lost-history','queued'));
    await d.ensureWakeDelivery({wakeId:'lost-history',matchId:'not-yet',
      triggerId:'no-prune-trigger',triggerVersion:'1',
      runtime:'fixture-host',now:at});
    await poolA.query('DELETE FROM '+history+
      " WHERE scope_id=$1 AND kind='wake' AND record_key=$2",
      [d.scopeId,'lost-history']);
    await assert.rejects(()=>verifyPostgresV1NoPruneRetention({
      store:d,wakeIds:['lost-history']}),
      e=>e.code==='EVENT_INTELLIGENCE_V1_RETENTION_RECEIPT_INVALID');
    const safe=await verifyPostgresV1NoPruneRetention({store:good});
    assert.equal(safe.sourceTailSequence,2);
    assert.equal(safe.auditEndSequence,1);
    assert.equal(safe.sourcePruneAuthorized,false);
    assert.equal((await good.listMcpOccurrencesAfter(0)).length,2);
  }finally{
    try{await cleanup(poolA,prefix)}finally{
      await Promise.allSettled([poolA.end(),poolB.end()]);
    }
  }
});

integration('PG16 no-prune preflight rejects huge source/dedup and audit JSONB before transferring bytes to Node',async()=>{
  const prefix='ei_v1_retention_bytes_'+randomBytes(5).toString('hex');
  const pool=new Pool({connectionString:url,max:3});
  const src=mk(pool,prefix,'heavy-source');
  const audit=mk(pool,prefix,'heavy-audit');
  try{
    await Promise.all([src.init(),audit.init()]);
    await src.appendMcpOccurrence('provider',{
      ...event('wide-source'),
      data:{blob:'S'.repeat(4000)},
    },'subscription');
    await audit.appendAudit({
      auditId:'large-audit',traceId:'wide-retention-audit',timestamp:at,
      kind:'trigger.created',entityType:'trigger',entityId:'heavy',
      details:{blob:'A'.repeat(4000)},
    });
    await assert.rejects(()=>src.listMcpOccurrencesAfter(0,{
      maxScanMs:1500,maxTotalBytes:1024}),
      e=>e.code==='EVENT_INTELLIGENCE_MCP_REPLAY_BUDGET_EXCEEDED');
    await assert.rejects(()=>src.getMcpOccurrenceArchiveCheckpoint({
      maxScanMs:1500,maxTotalBytes:1024}),
      e=>e.code==='EVENT_INTELLIGENCE_MCP_ARCHIVE_SCAN_BUDGET_EXCEEDED');
    await assert.rejects(()=>verifyPostgresV1NoPruneRetention({
      store:src,maxSourceBytes:1024}),
      e=>e.code==='EVENT_INTELLIGENCE_MCP_REPLAY_BUDGET_EXCEEDED');
    await assert.rejects(()=>audit.getAuditCheckpoint({
      maxScanMs:1500,maxTotalBytes:1024}),
      e=>e.code==='EVENT_INTELLIGENCE_AUDIT_CHECKPOINT_BUDGET_EXCEEDED');
    await assert.rejects(()=>verifyPostgresV1NoPruneRetention({
      store:audit,maxAuditBytes:1024}),
      e=>e.code==='EVENT_INTELLIGENCE_AUDIT_CHECKPOINT_BUDGET_EXCEEDED');
    // Per-record limits must also be enforced in PostgreSQL before any
    // oversized record is deserialized, even when its aggregate cap is ample.
    await assert.rejects(()=>src.listMcpOccurrencesAfter(0,{
      maxScanMs:1500,maxRowBytes:1024}),
      e=>e.code==='EVENT_INTELLIGENCE_MCP_REPLAY_BUDGET_EXCEEDED');
    await assert.rejects(()=>src.getMcpOccurrenceArchiveCheckpoint({
      maxScanMs:1500,maxRowBytes:1024}),
      e=>e.code==='EVENT_INTELLIGENCE_MCP_ARCHIVE_SCAN_BUDGET_EXCEEDED');
    await assert.rejects(()=>verifyPostgresV1NoPruneRetention({
      store:src,maxSourceRowBytes:1024}),
      e=>e.code==='EVENT_INTELLIGENCE_MCP_REPLAY_BUDGET_EXCEEDED');
    await assert.rejects(()=>audit.getAuditCheckpoint({
      maxScanMs:1500,maxRowBytes:1024}),
      e=>e.code==='EVENT_INTELLIGENCE_AUDIT_CHECKPOINT_BUDGET_EXCEEDED');
    await assert.rejects(()=>verifyPostgresV1NoPruneRetention({
      store:audit,maxAuditRowBytes:1024}),
      e=>e.code==='EVENT_INTELLIGENCE_AUDIT_CHECKPOINT_BUDGET_EXCEEDED');
    for(const request of [{store:src,maxSourceBytes:0},
      {store:audit,maxAuditBytes:64*1024*1024+1},
      {store:src,maxSourceRowBytes:0},
      {store:audit,maxAuditRowBytes:1024*1024+1}]){
      await assert.rejects(()=>verifyPostgresV1NoPruneRetention(request),
        e=>e.code==='EVENT_INTELLIGENCE_V1_RETENTION_POLICY_INVALID');
    }
    const sourceOk=await verifyPostgresV1NoPruneRetention({store:src});
    const auditOk=await verifyPostgresV1NoPruneRetention({store:audit});
    assert.equal(sourceOk.sourceTailSequence,1);
    assert.equal(auditOk.auditEndSequence,0);
    assert.equal(sourceOk.sourcePruneAuthorized,false);
    assert.equal(auditOk.auditPruneAuthorized,false);
    assert.equal(JSON.stringify(sourceOk).includes('SSSSSS'),false);
    assert.equal(JSON.stringify(auditOk).includes('AAAAAA'),false);
  }finally{
    try{await cleanup(pool,prefix)}finally{await pool.end();}
  }
});
