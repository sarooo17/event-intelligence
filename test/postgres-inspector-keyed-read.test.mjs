import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { PostgresEventStore } from '../scripts/lib/postgres-event-store.mjs';
import { TriggerInspector } from '../scripts/lib/trigger-inspector.mjs';

const url=process.env.POSTGRES_URL;
const integration=url?test:test.skip;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const prefix='ei_explain_key_'+randomBytes(6).toString('hex');
const at='2026-10-29T10:00:00.000Z';
const definition={
  triggerId:'same-trigger',version:'1',
  clauses:[{id:'x',event:'source.changed',serverId:'provider',where:[]}],
  pattern:{root:{kind:'event',ref:'x'}},withinMs:60000,
  target:{runtime:'host',kind:'task',id:'one'},
};
function match(scope,id){
  return {
    protocolVersion:'0.2.0',schemaVersion:'trigger.v0.2',
    matchId:id,triggerId:'same-trigger',triggerVersion:'1',
    status:'partial',partitionKey:null,openedAt:at,expiresAt:'2026-10-29T11:00:00.000Z',updatedAt:at,
    sourceEvents:[{clauseId:'x',traceId:'trace-'+scope,
      sourceEventId:'source-'+scope,eventName:'source.changed',
      serverId:'provider',occurredAt:at,
      data:{secret:'PRIVATE-'+scope}}],
    semanticDecision:null,patternState:{version:'2',role:'buffer',
      signature:'buffer-'+scope,semanticDecisions:[]},
    firedWakeId:null,derivedEventIds:[],
  };
}
integration('real PostgreSQL keyed inspector reads exact tenant match without wide trigger/match scans',async()=>{
  const pool=new Pool({connectionString:url,max:4});
  const a=new PostgresEventStore({pool,dispatchPoolIdentity:pool,tablePrefix:prefix,scopeId:'tenant-a'});
  const b=new PostgresEventStore({pool,dispatchPoolIdentity:pool,tablePrefix:prefix,scopeId:'tenant-b'});
  try{
    await a.init();await b.init();
    await a.putTrigger(definition);await b.putTrigger(definition);
    await a.appendTriggerMatch(match('tenant-a','same-match'));
    await b.appendTriggerMatch(match('tenant-b','same-match'));
    await a.appendTriggerMatch({
      ...match('tenant-a','newer-match'),
      updatedAt:'2026-10-29T10:01:00.000Z',
    });
    // Enforce SQL index-key read path, not an accidentally small wide scan.
    a.listTriggers=()=>{throw Error('unbounded listTriggers prohibited')};
    a.listTriggerMatches=()=>{throw Error('unbounded listTriggerMatches prohibited')};
    b.listTriggers=()=>{throw Error('unbounded listTriggers prohibited')};
    b.listTriggerMatches=()=>{throw Error('unbounded listTriggerMatches prohibited')};
    const insA=new TriggerInspector({store:a,matchHistoryLimit:1,evidenceRefLimit:1});
    const insB=new TriggerInspector({store:b,matchHistoryLimit:1,evidenceRefLimit:1});
    const [resultA,resultB]=await Promise.all([
      insA.inspect({triggerId:'same-trigger',version:'1',matchId:'same-match'}),
      insB.inspect({triggerId:'same-trigger',version:'1',matchId:'same-match'}),
    ]);
    const latestA=await insA.inspect({triggerId:'same-trigger',version:'1'});
    const latestB=await insB.inspect({triggerId:'same-trigger',version:'1'});
    assert.equal(latestA.match.matchId,'newer-match',
      'PG selector must order by actual persisted match timestamp');
    assert.equal(latestB.match.matchId,'same-match',
      'same trigger IDs in other tenant must remain isolated');
    assert.equal(resultA.match.matchId,'same-match');
    assert.equal(resultB.match.matchId,'same-match');
    assert.equal(resultA.lineage.evidence[0].sourceEventId,'source-tenant-a');
    assert.equal(resultB.lineage.evidence[0].sourceEventId,'source-tenant-b');
    assert.equal(JSON.stringify(resultA).includes('source-tenant-b'),false);
    assert.equal(JSON.stringify(resultB).includes('source-tenant-a'),false);
    assert.equal(JSON.stringify(resultA).includes('PRIVATE-'),false);
    assert.equal(JSON.stringify(resultB).includes('PRIVATE-'),false);
    await assert.rejects(()=>insA.inspect({
      triggerId:'same-trigger',version:'2',matchId:'same-match',
    }),e=>e?.code==='TRIGGER_NOT_FOUND');
    await assert.rejects(()=>insA.inspect({
      triggerId:'same-trigger',version:'1',matchId:'does-not-exist',
    }),e=>e?.code==='TRIGGER_MATCH_NOT_FOUND');
  }finally{
    for(const suffix of ['metadata','leases','history','records','counters']){
      await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    }
    await pool.end();
  }
});
