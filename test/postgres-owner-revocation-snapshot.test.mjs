import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import test from 'node:test';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
import {TriggerControlPlane} from '../scripts/lib/trigger-control-plane.mjs';
import {createOwnerReadGuard} from '../scripts/lib/mcp-owner-read-guard.mjs';

const url=process.env.POSTGRES_URL;
const {Pool}=url ? await import('pg') : {Pool:null};
const integration=url ? test : test.skip;
const alice={type:'user',principal_id:'shared-principal',tenant_id:'tenant-1'};
const reassigned={type:'user',principal_id:'shared-principal',tenant_id:'tenant-2'};
const actor={type:'system',principal_id:'owner-reassignment-operator'};
const triggerId='shared-owner-snapshot',version='1',matchId='match-private';

function definition(){
  return {
    triggerId,version,
    clauses:[{id:'ready',event:'fixture.owner.transfer',arguments:{},where:[]}],
    pattern:{version:'2',root:{kind:'event',ref:'ready'}},withinMs:60000,
    target:{runtime:'fixture-host',kind:'task',id:'noop'},
  };
}
function match(){
  const timestamp='2026-10-20T10:00:00.000Z';
  return {
    protocolVersion:'0.2.0',schemaVersion:'trigger.v0.2',
    matchId,triggerId,triggerVersion:version,status:'matched',
    partitionKey:null,openedAt:timestamp,expiresAt:'2026-10-20T10:01:00.000Z',
    updatedAt:timestamp,sourceEvents:[{
      clauseId:'ready',traceId:'owner-test',sourceEventId:'private-provider-event',
      eventName:'fixture.owner.transfer',serverId:'test',occurredAt:timestamp,
      data:{secret:'MUST-NOT-LEAK-AFTER-DENIAL'},
    }],
    semanticDecision:null,
    patternState:{version:'2',role:'buffer',signature:'owner-test',semanticDecisions:[]},
    firedWakeId:null,derivedEventIds:[],
  };
}
const notFound=error=>{
  assert.equal(error?.code,'EVENT_INTELLIGENCE_RESOURCE_NOT_FOUND');
  assert.equal(error?.message,'Resource not found for configured owner');
  assert.equal(String(error?.stack).includes('MUST-NOT-LEAK'),false);
  assert.equal(String(error?.cause).includes('MUST-NOT-LEAK'),false);
  return true;
};

async function fixture(fn){
  const prefix='ei_owner_snapshot_'+randomBytes(5).toString('hex');
  const poolA=new Pool({connectionString:url,max:4,statement_timeout:5000});
  const poolB=new Pool({connectionString:url,max:4,statement_timeout:5000});
  const a=new PostgresEventStore({
    pool:poolA,dispatchPoolIdentity:poolA,tablePrefix:prefix,scopeId:'owner-test',
  });
  const b=new PostgresEventStore({
    pool:poolB,dispatchPoolIdentity:poolB,tablePrefix:prefix,scopeId:'owner-test',
  });
  try{
    await Promise.all([a.init(),b.init()]);
    await a.putTrigger(definition());
    await a.setTriggerState(triggerId,version,'active',actor,{owner:alice});
    await a.appendTriggerMatch(match());
    await fn({a,b});
  }finally{
    try{
      for(const name of ['metadata','leases','history','records','counters']){
        await poolA.query('DROP TABLE IF EXISTS "'+prefix+'_'+name+'" CASCADE');
      }
    }finally{await Promise.allSettled([poolA.end(),poolB.end()]);}
  }
}

function captureFinalQuery(control,finalOrdinal){
  let count=0,notify,continueQuery;
  const seen=new Promise(resolve=>{notify=resolve;});
  const hold=new Promise(resolve=>{continueQuery=resolve;});
  return {
    triggerControl:{
      async listTriggers(input){
        const observed=await control.listTriggers(input); // real PG snapshot
        count++;
        if(count===finalOrdinal){
          notify();
          await hold;
        }
        return observed;
      },
    },
    seen,release:()=>continueQuery(),count:()=>count,
  };
}

integration('PG16 two-pool owner transfer AFTER final SQL authorization snapshot permits already-authorized inspector read',()=>fixture(async({a,b})=>{
  const control=new TriggerControlPlane({store:a});
  const captured=captureFinalQuery(control,2); // inspect: initial + final
  const guard=createOwnerReadGuard({store:a,triggerControl:captured.triggerControl,owner:alice});
  const pending=guard.withAuthorizedTriggerResult(triggerId,version,
    async()=>({evidence:'ALREADY-AUTHORIZED-INSPECT-RESULT'}));
  await captured.seen;
  const revoked=await b.setTriggerState(triggerId,version,'active',actor,{
    owner:reassigned,
  });
  assert.equal(revoked.owner.tenant_id,'tenant-2');
  captured.release();
  assert.deepEqual(await pending,{evidence:'ALREADY-AUTHORIZED-INSPECT-RESULT'});
  assert.equal(captured.count(),2);
  // A new read, whose authorization snapshot is AFTER reassignment commits,
  // must never observe the old principal's definition.
  await assert.rejects(
    ()=>new TriggerControlPlane({store:a}).listTriggers({owner:alice})
      .then(rows=>{assert.deepEqual(rows,[]);return guard.assertTrigger(triggerId,version);}),
    notFound,
  );
  const newGuard=createOwnerReadGuard({
    store:b,triggerControl:new TriggerControlPlane({store:b}),owner:reassigned,
  });
  assert.equal((await newGuard.assertTrigger(triggerId,version)).state.owner.tenant_id,
    'tenant-2');
}));

integration('PG16 owner transfer BEFORE final query snapshot denies inspector despite completed evidence hydration',()=>fixture(async({a,b})=>{
  const control=new TriggerControlPlane({store:a});
  let readEntered,releaseBuild;
  const entered=new Promise(resolve=>{readEntered=resolve;});
  const blocked=new Promise(resolve=>{releaseBuild=resolve;});
  const guard=createOwnerReadGuard({store:a,triggerControl:control,owner:alice});
  const pending=guard.withAuthorizedTriggerResult(triggerId,version,async()=>{
    readEntered();
    await blocked;
    return {evidence:'MUST-NOT-LEAK-AFTER-DENIAL'};
  });
  await entered;
  await b.setTriggerState(triggerId,version,'active',actor,{owner:reassigned});
  releaseBuild();
  await assert.rejects(pending,notFound);
  await assert.rejects(()=>guard.assertTrigger(triggerId,version),notFound);
}));

integration('PG16 two-pool wake result keeps final-query linearization point and denies subsequent old-tenant reads',()=>fixture(async({a,b})=>{
  const wakeId='durable-pinned-wake';
  await a.ensureWakeDelivery({
    wakeId,matchId,triggerId,triggerVersion:version,
    runtime:'fixture-host',now:'2026-10-20T10:00:00.000Z',
  });
  await a.appendWake({
    wakeId,traceId:'owner-test',decisionId:null,
    subscriptionId:'trigger:'+triggerId,sourceEventId:matchId,
    createdAt:'2026-10-20T10:00:00.000Z',
    target:definition().target,status:'queued',
  });
  const observed=captureFinalQuery(new TriggerControlPlane({store:a}),3);
  const guard=createOwnerReadGuard({store:a,triggerControl:observed.triggerControl,owner:alice});
  const pending=guard.withAuthorizedWakeResult(wakeId,async()=>({
    reference:'WAKE-EVIDENCE-ALREADY-AUTHORIZED',
  }));
  await observed.seen;
  await b.setTriggerState(triggerId,version,'active',actor,{owner:reassigned});
  observed.release();
  assert.deepEqual(await pending,{reference:'WAKE-EVIDENCE-ALREADY-AUTHORIZED'});
  await assert.rejects(()=>guard.withAuthorizedWakeResult(wakeId,async()=>({
    reference:'must-not-return',
  })),notFound);
}));

integration('PG16 wake hydration denies and redacts result when transfer commits BEFORE final query',()=>fixture(async({a,b})=>{
  const wakeId='revoked-during-wake-hydration';
  await a.ensureWakeDelivery({
    wakeId,matchId,triggerId,triggerVersion:version,
    runtime:'fixture-host',now:'2026-10-20T10:00:00.000Z',
  });
  await a.appendWake({
    wakeId,traceId:'owner-test',decisionId:null,
    subscriptionId:'trigger:'+triggerId,sourceEventId:matchId,
    createdAt:'2026-10-20T10:00:00.000Z',
    target:definition().target,status:'queued',
  });
  let entered,releaseHydration;
  const started=new Promise(resolve=>{entered=resolve;});
  const blocked=new Promise(resolve=>{releaseHydration=resolve;});
  const guard=createOwnerReadGuard({
    store:a,triggerControl:new TriggerControlPlane({store:a}),owner:alice,
  });
  const pending=guard.withAuthorizedWakeResult(wakeId,async()=>{
    entered();
    await blocked;
    return {secret:'MUST-NOT-LEAK-AFTER-DENIAL'};
  });
  await started;
  await b.setTriggerState(triggerId,version,'active',actor,{owner:reassigned});
  releaseHydration();
  await assert.rejects(pending,notFound);
  await assert.rejects(()=>guard.assertWake(wakeId),notFound);
}));
