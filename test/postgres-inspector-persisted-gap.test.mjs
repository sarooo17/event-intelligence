import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
import {TriggerInspector} from '../scripts/lib/trigger-inspector.mjs';
const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const prefix='ei_gap_explain_'+randomBytes(6).toString('hex');
const definition={
  triggerId:'same-trigger',version:'1',
  clauses:[{id:'source',event:'state.changed',serverId:'provider',arguments:{},where:[]}],
  pattern:{version:'2',root:{kind:'event',ref:'source'}},
  withinMs:60000,target:{runtime:'host',kind:'task',id:'job'},
};
function store(pool,id){return new PostgresEventStore({
  pool,dispatchPoolIdentity:pool,tablePrefix:prefix,scopeId:id});
}
async function setup(db,tenant){
  await db.init();await db.putTrigger(definition);
  await db.setTriggerState('same-trigger','1','active',null,
    {connectionIds:['connection'],owner:{type:'user',principal_id:tenant,tenant_id:tenant}});
  await db.putEventSource({sourceId:'s',connectionId:'connection',serverId:'provider',
    eventName:'state.changed',delivery:['poll'],enabled:true});
}
const key={connectionId:'connection',serverId:'provider',
  eventName:'state.changed',arguments:{}};
integration('real PG16 scoped MCP persisted gap shows no cross-tenant explanation and survives pool reopen',async()=>{
  let pool=new Pool({connectionString:url,max:4});
  let replacement=null;
  try{
    const a=store(pool,'tenant-a'),b=store(pool,'tenant-b');
    await setup(a,'tenant-a');await setup(b,'tenant-b');
    await a.putMcpClientState({...key,truncated:true});
    const inspectA=()=>new TriggerInspector({store:a})
      .inspect({triggerId:'same-trigger',version:'1'});
    const inspectB=()=>new TriggerInspector({store:b})
      .inspect({triggerId:'same-trigger',version:'1'});
    assert.equal((await inspectA()).diagnosisV2.kind,'source_gap_unresolved');
    assert.equal((await inspectB()).diagnosisV2.kind,'not_yet_satisfied');
    await pool.end();
    replacement=new Pool({connectionString:url,max:4});
    const newA=store(replacement,'tenant-a'),newB=store(replacement,'tenant-b');
    await newA.init();await newB.init();
    const persisted=await new TriggerInspector({store:newA})
      .inspect({triggerId:'same-trigger',version:'1'});
    assert.equal(persisted.diagnosisV2.kind,'source_gap_unresolved');
    assert.equal((await new TriggerInspector({store:newB})
      .inspect({triggerId:'same-trigger',version:'1'})).diagnosisV2.kind,
      'not_yet_satisfied');
    const previous=await newA.getMcpClientState('connection','state.changed',{});
    await newA.putMcpClientState({...key,gapReconciled:true,
      expectedCompletenessRevision:previous.completenessRevision,
      reconciliationEvidenceId:'host-replay-evidence'});
    assert.equal((await new TriggerInspector({store:newA})
      .inspect({triggerId:'same-trigger',version:'1'})).diagnosisV2.kind,
      'not_yet_satisfied');
  }finally{
    const cleanupPool=replacement??pool;
    for(const suffix of ['metadata','leases','history','records','counters']){
      await cleanupPool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    }
    await cleanupPool.end();
  }
});
