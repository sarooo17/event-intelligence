import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
import {TriggerInspector} from '../scripts/lib/trigger-inspector.mjs';
import {profileFullInspector} from '../scripts/validation/e48b-inspector-profile.mjs';

const url=process.env.POSTGRES_URL;
const integration=url?test:test.skip;
integration('E48-B runs the unmocked strict full TriggerInspector over real PG16 candidate rows',async()=>{
 const {Pool}=(await import('pg')).default;
 const prefix='ei_e48b_ci_'+randomBytes(5).toString('hex');
 const pool=new Pool({connectionString:url,max:3,statement_timeout:10000});
 const scope='e48b-profile-sample';
 const store=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
  tablePrefix:prefix,scopeId:scope});
 try{
  await store.init();
  await store.putTrigger({triggerId:'e48-inspected',version:'1',
   clauses:[{id:'changed',event:'fixture.changed',
    serverId:'e48b-benchmark',arguments:{},where:[]}],
   pattern:{version:'2',root:{kind:'event',ref:'changed'}},
   withinMs:60000,target:{runtime:'host',kind:'task',id:'inspect'}});
  await store.setTriggerState('e48-inspected','1','active',null);
  const at='2026-11-01T00:00:00.000Z';
  for(const i of [1,2,3]){
   await store.appendTriggerMatch({
    protocolVersion:'0.2.0',schemaVersion:'trigger.v0.2',
    matchId:'candidate-'+String(i).padStart(6,'0'),
    triggerId:'e48-inspected',triggerVersion:'1',
    status:'partial',partitionKey:null,openedAt:at,updatedAt:at,
    expiresAt:at,sourceEvents:[],semanticDecision:null,
    firedWakeId:null,derivedEventIds:[],
    patternState:{version:'2',role:'buffer',maxObservedOccurredAt:at,
     semanticDecisions:[]},
   });
  }
  const inspector=new TriggerInspector({store,
   inspectionWindowLimit:8,matchHistoryLimit:8,evidenceRefLimit:8});
  const result=await profileFullInspector({inspector,ids:[
   'candidate-000001','candidate-000002','candidate-000003',
  ],iterations:9});
  assert.equal(result.fullInspectorCalls,9);
  assert.equal(result.successes,9);
  assert.equal(result.refusals,0);
  assert.equal(result.samples.length,9);
  assert(result.percentileLatencyMs.p99>=result.percentileLatencyMs.p50);
  assert.equal(result.measurementIncludesFullInspector,true);
 }finally{
  for(const suffix of ['metadata','leases','history','records','counters']){
   await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE').catch(()=>{});
  }
  await pool.end();
 }
});
