import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
import {TriggerInspector} from '../scripts/lib/trigger-inspector.mjs';

const url=process.env.POSTGRES_URL;
const integration=url?test:test.skip;
integration('E48-A PG16 refuses ambiguous duplicate source identity then reports actual persisted HTTP truncation after known fixture cleanup',async()=>{
  const {Pool}=(await import('pg')).default;
  const prefix='ei_e48_unique_'+randomBytes(6).toString('hex');
  const pool=new Pool({connectionString:url,max:4,statement_timeout:12000});
  const scope='e48-unique-'+randomBytes(5).toString('hex');
  const db=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
    scopeId:scope,tablePrefix:prefix});
  const key={connectionId:'e48-fixture-connection',
    serverId:'e48-fixture-provider',eventName:'fixture.changed',arguments:{}};
  const def={triggerId:'e48-gap',version:'1',
    clauses:[{id:'changed',serverId:key.serverId,event:key.eventName,
      where:[],arguments:{}}],
    pattern:{version:'2',root:{kind:'event',ref:'changed'}},
    withinMs:60000,target:{runtime:'host',kind:'task',id:'fixture'}};
  const inspect=()=>new TriggerInspector({
    store:db,inspectionWindowLimit:3,evidenceRefLimit:3,matchHistoryLimit:3,
  }).inspect({triggerId:'e48-gap',version:'1'});
  try{
    await db.init();
    await db.putTrigger(def);
    await db.setTriggerState('e48-gap','1','active',null,{
      connectionIds:[key.connectionId],
      owner:{type:'user',principal_id:scope,tenant_id:scope}});
    await db.putEventSource({sourceId:'canonical',...key,
      enabled:true,delivery:['poll']});
    await db.putEventSource({sourceId:'accidental-duplicate',...key,
      enabled:true,delivery:['poll']});
    const persisted=await db.putMcpClientState({...key,
      sourceAvailability:'available',truncated:true});
    assert.equal(persisted.gapUnresolved,true);
    assert.equal(persisted.truncated,true);
    const before=await inspect();
    assert.notEqual(before.diagnosisV2.kind,'source_gap_unresolved',
      'ambiguous source identity must not be promoted to a uniquely attributed source fact');
    await db.putEventSource({sourceId:'accidental-duplicate',...key,
      enabled:false,delivery:['poll']});
    const active=(await db.listEventSources({
      connectionIds:[key.connectionId],enabledOnly:true}))
      .filter(x=>x.serverId===key.serverId&&x.eventName===key.eventName);
    assert.deepEqual(active.map(x=>x.sourceId),['canonical']);
    const after=await inspect();
    assert.equal(after.diagnosisV2.kind,'source_gap_unresolved');
    const state=await db.getMcpClientState(key.connectionId,key.eventName,{});
    assert.equal(state.gapUnresolved,true);
    assert.equal(state.truncated,true);
  }finally{
    for(const kind of ['metadata','leases','history','records','counters']){
      await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+kind+'" CASCADE').catch(()=>{});
    }
    await pool.end();
  }
});
