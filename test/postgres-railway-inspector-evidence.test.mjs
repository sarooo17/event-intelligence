import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
import {measureRailwayInspector} from '../scripts/validation/inspector-profile.mjs';
const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const prefix='ei_insp_railway_'+randomBytes(5).toString('hex');
integration('PG16 strict full-path campaign inspector returns bounded raw real latency/CPU/IO metrics without source payload',async()=>{
 const pool=new Pool({connectionString:url,max:3});
 const scopeId='ei-validation:fixture-1';
 const db=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
   tablePrefix:prefix,scopeId});
 const now='2026-10-30T12:00:00.000Z';
 try{
   await db.init();
   await db.putTrigger({
     triggerId:'railway-slot-0',version:'1',
     clauses:[{id:'changed',event:'railway.validation.changed.0',where:[]}],
     pattern:{version:'2',root:{kind:'event',ref:'changed'}},
     withinMs:60000,target:{runtime:'test',kind:'task',id:'task'},
   });
   await db.setTriggerState('railway-slot-0','1','active',null);
   await db.appendTriggerMatch({
     protocolVersion:'0.2.0',schemaVersion:'trigger.v0.2',
     matchId:'inspect-fixture-1',triggerId:'railway-slot-0',triggerVersion:'1',
     status:'partial',partitionKey:null,openedAt:now,expiresAt:now,updatedAt:now,
     sourceEvents:[],semanticDecision:null,firedWakeId:null,derivedEventIds:[],
   });
   const report=await measureRailwayInspector({pool,tablePrefix:prefix,
     scopeId,triggerCount:1,triggerLimit:1,samplesPerTrigger:3});
   assert.equal(report.contract,'ei.railway-strict-inspector-evidence.v1');
   assert.equal(report.samples,3);assert.equal(report.successes,3);
   assert.equal(report.refusals,0);
   assert.equal(report.latencySamplesMs.length,3);
   assert(report.elapsedMs.p99>=0);
   assert(Number.isFinite(report.nodeCpuMicros.user));
   assert(Number.isFinite(report.pgDatabaseGlobalDelta.blks_hit));
   assert.equal(report.pgCountersAreScopeIsolated,false);
   assert.equal(report.productionSloCertified,false);
   assert(!JSON.stringify(report).includes('inspect-fixture-1'),
      'raw match IDs are not exported');
   for(const invalid of [0,21,Infinity,'10']){
     await assert.rejects(()=>measureRailwayInspector({pool,tablePrefix:prefix,
       scopeId,triggerCount:1,triggerLimit:invalid}),RangeError);
   }
 }finally{
   for(const suffix of ['metadata','leases','history','records','counters']){
     await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
   }
   await pool.end();
 }
});
