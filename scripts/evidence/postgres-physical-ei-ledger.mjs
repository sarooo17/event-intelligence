import { createHash } from 'node:crypto';
import { PostgresEventStore } from '../lib/postgres-event-store.mjs';
import { CompositeTriggerEngine } from '../../dist/src/composite/engine.js';
import { CompositeWakeCoordinator } from '../lib/composite-wake-coordinator.mjs';
import { sha256Hex, WakeRecordSchema } from '../../dist/src/intelligenceProtocol/index.js';

const PREFIX='ei_physical_standby_ci';
const SCOPE='ci-physical-standby';
const AT='2026-10-29T10:00:00.000Z';
const fail=(code)=>{throw new Error('EI_PHYSICAL_EI_RECEIPT_FAILED:'+code);};
const storeFor=pool=>new PostgresEventStore({
  pool,dispatchPoolIdentity:pool,tablePrefix:PREFIX,scopeId:SCOPE,
});
const definition=slot=>({
  triggerId:'pg-physical-wake-'+slot,version:'1',
  clauses:[{id:'change',event:'fixture.physical.confirmed',
    arguments:{},where:[{path:'slot',op:'eq',value:slot}]}],
  pattern:{version:'2',root:{kind:'event',ref:'change'}},
  withinMs:60000,
  lifecycle:{oneShot:false,cooldownMs:0,completeOnGoal:false},
  target:{runtime:'disposable-host',kind:'task',id:'continuation-'+slot},
});
const event=slot=>({
  traceId:'physical-trace-'+slot,sourceEventId:'physical-source-'+slot,
  name:'fixture.physical.confirmed',occurredAt:AT,
  serverId:'disposable-provider',data:{slot},
});

/**
 * Both receipts are *acknowledged and WAL-replayed* before killing primary.
 * The two cases strand different EI finalize boundaries, so a successor must
 * complete EI-only state instead of calling the host.
 */
export async function seedPhysicalEiLedger(primaryPool) {
  const store=storeFor(primaryPool);
  await store.init();
  const engine=new CompositeTriggerEngine(store);
  const seeded=[];
  for (const slot of [0,1]) {
    const def=definition(slot);
    await engine.register(def);
    const rows=await engine.ingest(event(slot));
    const match=rows.filter(row=>row.matched&&row.triggerId===def.triggerId&&
      row.match?.status==='matched');
    if(match.length!==1)fail('one-logical-match-required');
    const matched=match[0].match;
    const wakeId='wake_'+(await sha256Hex(
      'composite:'+matched.matchId+':'+def.target.runtime+':'+def.target.id,
    )).slice(0,24);
    const receiptId='host-confirmed:'+wakeId;
    await store.ensureWakeDelivery({
      wakeId,matchId:matched.matchId,triggerId:def.triggerId,
      triggerVersion:def.version,runtime:def.target.runtime,now:AT,
    });
    const claim=await store.claimWakeDelivery(wakeId,{
      workerId:'victim-before-physical-failover',now:AT,leaseMs:1000,
    });
    if(claim?.attemptCount!==1)fail('initial-claim-not-unique');
    await store.appendWake(WakeRecordSchema.parse({
      wakeId,traceId:matched.sourceEvents[0]?.traceId??matched.matchId,
      decisionId:null,subscriptionId:'trigger:'+def.triggerId,
      sourceEventId:matched.matchId,createdAt:AT,target:def.target,
      status:'queued',
    }));
    const receipt=await store.completeWakeDelivery(wakeId,{
      workerId:'victim-before-physical-failover',attemptCount:claim.attemptCount,
      runtimeReceiptId:receiptId,now:AT,
    });
    if(receipt?.status!=='delivered')fail('durable-receipt-not-committed');
    if(slot===1) {
      await store.appendWake(WakeRecordSchema.parse({
        wakeId,traceId:matched.matchId,decisionId:null,
        subscriptionId:'trigger:'+def.triggerId,
        sourceEventId:matched.matchId,createdAt:AT,target:def.target,
        status:'delivered',runtimeReceiptId:receiptId,
      }));
    }
    const last=(await store.listTriggerMatches(def.triggerId)).find(x=>x.matchId===matched.matchId);
    if(last?.status!=='matched')fail('finalize-gap-not-staged');
    seeded.push({triggerId:def.triggerId,matchId:matched.matchId,wakeId,
      runtimeReceiptId:receiptId,slot});
  }
  if(await store.verifyAudit()!==true)fail('primary-audit-not-verified');
  return seeded;
}

/** Run after pg_promote on a *new client pool* connected to physical standby. */
export async function verifyEiLedgerAfterPhysicalPromotion(promotedPool,seeded) {
  if(!Array.isArray(seeded)||seeded.length!==2)fail('seed-evidence-missing');
  const store=storeFor(promotedPool);
  await store.init();
  let forbiddenHostCalls=0;
  const coordinator=new CompositeWakeCoordinator({
    store,triggerEngine:new CompositeTriggerEngine(store),
    workerId:'promoted-standby-ei-recovery',now:()=>new Date(AT),
    deliverer:async()=>{
      forbiddenHostCalls++;
      throw Error('External host must not be reinvoked for durable receipt');
    },
  });
  let finalized=0;
  for(const row of seeded) {
    const original=(await store.listTriggerMatches(row.triggerId))
      .find(x=>x.matchId===row.matchId);
    if(original?.status!=='matched')fail('matched-state-lost-after-promotion');
    const received=await store.getWakeDelivery(row.wakeId);
    if(received?.status!=='delivered' ||
        received.runtimeReceiptId!==row.runtimeReceiptId ||
        received.attemptCount!==1)fail('acknowledged-wake-receipt-lost-after-promotion');
    const result=await coordinator.deliverMatched(original);
    if(result.status!=='wake_delivered' ||
        result.wake.runtimeReceiptId!==row.runtimeReceiptId ||
        result.wake.wakeId!==row.wakeId)fail('recovery-could-not-finalize');
    const fired=(await store.listTriggerMatches(row.triggerId))
      .find(x=>x.matchId===row.matchId);
    if(fired?.status!=='fired'||fired.firedWakeId!==row.wakeId) {
      fail('match-not-finished-after-promotion');
    }
    const repeated=await coordinator.deliverMatched(fired);
    if(repeated.status!=='already_fired')fail('replay-redelivered-host');
    const raw=await promotedPool.query(
      'SELECT payload->>\'status\' AS status, payload->>\'runtimeReceiptId\' AS receipt '+
      'FROM "'+PREFIX+'_history" WHERE scope_id=$1 AND kind=$2 AND record_key=$3',
      [SCOPE,'wake',row.wakeId],
    );
    const queued=raw.rows.filter(x=>x.status==='queued').length;
    const delivered=raw.rows.filter(x=>x.status==='delivered');
    if(queued!==1||delivered.length!==1||
        delivered[0].receipt!==row.runtimeReceiptId)fail('wake-history-mismatch');
    finalized++;
  }
  if(forbiddenHostCalls!==0 || await store.verifyAudit()!==true)fail('host-reinvoked-or-audit-broken');
  return {
    status:'passed',stagedFinalizationBoundaries:seeded.length,
    finalizedAfterPhysicalPromotion:finalized,
    lostDurableHostReceipts:0,duplicateHostCallsAfterPromotion:forbiddenHostCalls,
    auditChainVerified:true,
    sourceEventIdentitiesSha256:createHash('sha256')
      .update(JSON.stringify(seeded.map(x=>x.matchId))).digest('hex'),
    productionHaCertified:false,
  };
}
