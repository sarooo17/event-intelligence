import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import test from 'node:test';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';

const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const before='2026-10-10T00:00:00.000Z';
const at='2026-10-05T10:00:00.000Z';
function match(id,status='fired') {
  return {protocolVersion:'0.2.0',schemaVersion:'trigger.v0.2',
    matchId:id,triggerId:'scope-retention-trigger',triggerVersion:'1',
    status,partitionKey:null,openedAt:at,expiresAt:'2026-10-05T10:01:00.000Z',
    updatedAt:at,sourceEvents:[],semanticDecision:null,
    patternState:{version:'2',role:'match',signature:id,semanticDecisions:[]},
    firedWakeId:status==='fired'?'wake-'+id:null,derivedEventIds:[]};
}
function wake(id,status='delivered') {
  return {wakeId:id,traceId:'retention-trace',decisionId:null,
    subscriptionId:'trigger:scope-retention-trigger',
    sourceEventId:'match-'+id,createdAt:at,status,
    target:{runtime:'fixture-host',kind:'task',id}};
}
async function durable(store,id) {
  await store.ensureWakeDelivery({wakeId:id,matchId:'match-'+id,
    triggerId:'scope-retention-trigger',triggerVersion:'1',
    runtime:'fixture-host',now:at});
  const claimed=await store.claimWakeDelivery(id,{workerId:'retention-owner',
    now:at,leaseMs:1000});
  assert.ok(claimed);
  await store.completeWakeDelivery(id,{workerId:'retention-owner',
    attemptCount:claimed.attemptCount,runtimeReceiptId:'host:'+id,
    now:'2026-10-05T10:00:00.500Z'});
}

integration('PG16 paged terminal-retention sweep only removes duplicate safe snapshots, with independent workers and tenants',async()=>{
  const prefix='ei_scope_sweep_'+randomBytes(5).toString('hex');
  const poolA=new Pool({connectionString:url,max:3});
  const poolB=new Pool({connectionString:url,max:3});
  const make=(pool,scope)=>new PostgresEventStore({pool,
    dispatchPoolIdentity:pool,scopeId:scope,tablePrefix:prefix});
  const a=make(poolA,'tenant-A'),peer=make(poolB,'tenant-A');
  const b=make(poolB,'tenant-B');
  const history='"'+prefix+'_history"';
  try {
    await Promise.all([a.init(),peer.init(),b.init()]);
    for(const id of ['a-fired','b-fired']) {
      for(let i=0;i<5;i++) await a.appendTriggerMatch(match(id));
    }
    for(let i=0;i<5;i++) await a.appendTriggerMatch(match('c-active','matched'));
    for(let i=0;i<5;i++) await b.appendTriggerMatch(match('a-fired'));
    for(const id of ['a-delivered','b-delivered']) {
      for(let i=0;i<5;i++) await a.appendWake(wake(id));
      await durable(a,id);
    }
    for(let i=0;i<5;i++) await a.appendWake(wake('c-pending','queued'));
    for(let i=0;i<5;i++) await b.appendWake(wake('a-delivered'));
    await a.appendAudit({auditId:'sweep-audit',traceId:'sweep-trace',
      timestamp:at,kind:'trigger.created',entityType:'trigger',
      entityId:'scope-retention-trigger',details:{immutable:true}});
    await a.appendMcpOccurrence('source-server',{
      eventId:'source-event',name:'scope.retention.changed',timestamp:at,data:{value:1}
    },'subscription-A');
    const checkpoint=await a.getMcpOccurrenceArchiveCheckpoint();
    const anchor=await a.getAuditCheckpoint();
    const originalSource=await a.listMcpOccurrencesAfter(0);
    const originalAudit=await a.listAudit();
    const originalDelivery=await a.getWakeDelivery('a-delivered');
    await poolA.query('UPDATE '+history+
      ' SET created_at=$1::timestamptz WHERE scope_id=$2 AND kind=ANY($3)',
      ['2026-10-08T10:00:00.000Z','tenant-A',
        ['wake','trigger_match_history']]);

    const preview=await a.compactScopedTerminalHistoryBatch({
      kind:'trigger_match_history',before,maxKeys:1,maxRows:10,
    });
    assert.equal(preview.dryRun,true);
    assert.equal(preview.inspected,1);
    assert.equal(preview.deleted,0);
    assert.equal(preview.eligible,3);
    assert.equal(preview.hasMore,true);
    assert.equal((await a.listTriggerMatchHistory('a-fired')).length,5);
    const first=await peer.compactScopedTerminalHistoryBatch({
      kind:'trigger_match_history',before,maxKeys:1,maxRows:10,dryRun:false,
    });
    assert.equal(first.deleted,3);
    assert.equal(first.nextAfterKey,'a-fired');
    const next=await a.compactScopedTerminalHistoryBatch({
      kind:'trigger_match_history',before,afterKey:first.nextAfterKey,
      maxKeys:2,maxRows:10,dryRun:false,
    });
    assert.equal(next.inspected,2);
    assert.equal(next.deleted,3);
    assert.equal(next.rows.find(r=>r.key==='c-active')?.skipped,'not_fired');
    assert.equal((await a.listTriggerMatchHistory('a-fired')).length,2);
    assert.equal((await a.listTriggerMatchHistory('b-fired')).length,2);
    assert.equal((await a.listTriggerMatchHistory('c-active')).length,5);
    assert.equal((await b.listTriggerMatchHistory('a-fired')).length,5);
    assert.equal((await peer.compactScopedTerminalHistoryBatch({
      kind:'trigger_match_history',before,maxKeys:3,dryRun:false,
    })).deleted,0,'repeating a batch must not delete unique witnesses');

    const wakeRun=await peer.compactScopedTerminalHistoryBatch({
      kind:'wake',before,maxKeys:3,dryRun:false,
    });
    assert.equal(wakeRun.inspected,3);
    assert.equal(wakeRun.deleted,6);
    assert.equal(wakeRun.rows.find(r=>r.key==='c-pending')?.skipped,
      'not_durably_delivered');
    assert.equal((await peer.latestWake('a-delivered')).status,'delivered');
    assert.deepEqual(await peer.getWakeDelivery('a-delivered'),originalDelivery);
    assert.equal((await b.restoredCounts()).wakes,5);
    assert.equal(await peer.claimWakeDelivery('a-delivered',{
      workerId:'late-worker',now:'2026-10-05T10:01:00.000Z'}),null);
    assert.deepEqual(await peer.listMcpOccurrencesAfter(0),originalSource);
    assert.deepEqual(await peer.getMcpOccurrenceArchiveCheckpoint(),checkpoint);
    assert.deepEqual(await peer.getAuditCheckpoint(),anchor);
    assert.deepEqual(await peer.listAudit(),originalAudit);
    assert.equal(await peer.verifyAudit(),true);

    // A record with more than maxRows eligible revisions MUST remain on
    // the next page. The cursor cannot skip a partly compacted key.
    for(let i=0;i<5;i++)await a.appendTriggerMatch(match('z-cap'));
    await poolA.query('UPDATE '+history+
      ' SET created_at=$1::timestamptz WHERE scope_id=$2 AND kind=$3 AND record_key=$4',
      ['2026-10-08T10:00:00.000Z','tenant-A','trigger_match_history','z-cap']);
    for(let n=0;n<3;n++){
      const step=await peer.compactScopedTerminalHistoryBatch({
        kind:'trigger_match_history',before,afterKey:'c-active',
        maxKeys:1,maxRows:1,dryRun:false,
      });
      assert.equal(step.deleted,1);
      assert.equal(step.hasMore,true);
      assert.equal(step.cappedKey,'z-cap');
      assert.equal(step.nextAfterKey,'c-active',
        'partially compacted key must be re-visited on the next page');
    }
    const capFinished=await peer.compactScopedTerminalHistoryBatch({
      kind:'trigger_match_history',before,afterKey:'c-active',
      maxKeys:1,maxRows:1,dryRun:false,
    });
    assert.equal(capFinished.deleted,0);
    assert.equal(capFinished.cappedKey,null);
    assert.equal(capFinished.nextAfterKey,'z-cap');
    assert.equal(capFinished.hasMore,false);
    assert.equal((await peer.listTriggerMatchHistory('z-cap')).length,2);

    // A failure after one successfully committed key must expose the
    // actual last committed cursor, instead of losing progress metadata.
    for(let n=0;n<4;n++) await a.appendTriggerMatch(match('x-ok'));
    for(let n=0;n<5;n++) await a.appendTriggerMatch(match('y-error'));
    await poolA.query('UPDATE '+history+
      ' SET created_at=$1::timestamptz WHERE scope_id=$2 AND kind=$3' +
      ' AND record_key=ANY($4::text[])',
      ['2026-10-08T10:00:00.000Z','tenant-A',
        'trigger_match_history',['x-ok','y-error']]);
    await assert.rejects(()=>peer.compactScopedTerminalHistoryBatch({
      kind:'trigger_match_history',before,afterKey:'c-active',
      maxKeys:2,maxHistoryRows:4,dryRun:false,
    }),e=>{
      assert.equal(e.code,'EVENT_INTELLIGENCE_MATCH_HISTORY_SCAN_BUDGET_EXCEEDED');
      assert.equal(e.partialProgress?.failedKey,'y-error');
      assert.equal(e.partialProgress?.nextAfterKey,'x-ok');
      assert.equal(e.partialProgress?.deleted,2);
      assert.equal(e.partialProgress?.inspected,1);
      assert.equal(e.partialProgress?.hasMore,true);
      return true;
    });
    assert.equal((await a.listTriggerMatchHistory('x-ok')).length,2);
    assert.equal((await a.listTriggerMatchHistory('y-error')).length,5,
      'failing key must not have a partial physical DELETE');
    assert.equal(await peer.verifyAudit(),true);

    for(const bad of [
      {},{kind:'audit',before},{kind:'wake',before:'2026-10-10'},
      {kind:'wake',before:'2999-01-01T00:00:00Z'},
      {kind:'wake',before,maxKeys:0},{kind:'wake',before,maxKeys:33},
      {kind:'wake',before,maxRows:0},{kind:'wake',before,maxScanMs:99},
      {kind:'wake',before,dryRun:'false'}
    ]) {
      await assert.rejects(()=>a.compactScopedTerminalHistoryBatch(bad),
        e=>e?.code==='EVENT_INTELLIGENCE_TERMINAL_SWEEP_POLICY_INVALID');
    }
  } finally {
    try {
      for(const suffix of ['metadata','leases','history','records','counters']) {
        await poolA.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
      }
    } finally {
      await Promise.allSettled([poolA.end(),poolB.end()]);
    }
  }
});
