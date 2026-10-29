import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const prefix='ei_inspect_window_'+randomBytes(6).toString('hex');
integration('PG16 bounded scoped inspection uses rows not full lists and fails on overflow',async()=>{
  const pool=new Pool({connectionString:url,max:4});
  const a=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
    tablePrefix:prefix,scopeId:'tenant-a'});
  const b=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
    tablePrefix:prefix,scopeId:'tenant-b'});
  try{
    await a.init();await b.init();
    for(let i=0;i<4;i++){
      await a.putTemporalDeadline({deadlineId:'a-'+i,
        triggerId:'t',matchId:'m',conditionId:'a',
        dueAt:'2026-10-29T10:30:00.000Z',status:'pending'});
      await b.putTemporalDeadline({deadlineId:'b-'+i,
        triggerId:'t',matchId:'m',conditionId:'b',
        dueAt:'2026-10-29T10:30:00.000Z',status:'pending'});
    }
    const a2=await a.getBoundedInspectionDeadlines('m',{limit:2});
    const b2=await b.getBoundedInspectionDeadlines('m',{limit:2});
    assert.equal(a2.records.length,2);
    assert.equal(a2.hasMore,true);
    assert.equal(b2.hasMore,true);
    assert(a2.records.every(row=>row.deadlineId.startsWith('a-')));
    assert(b2.records.every(row=>row.deadlineId.startsWith('b-')));
    const final=await a.getBoundedInspectionDeadlines('m',{limit:4});
    assert.equal(final.records.length,4);
    assert.equal(final.hasMore,false);
    const unknown=await a.getBoundedInspectionDeadlines('not-this-match',{limit:2});
    assert.deepEqual(unknown.records,[]);
    assert.equal(unknown.hasMore,false);
    for(let i=0;i<4;i++){
      await a.upsert('derived_event','da-'+i,{
        triggerId:'t',matchId:'m',
        event:{sourceEventId:'a'+i,name:'derived',occurredAt:
          '2026-10-29T10:00:00.000Z',data:{}},
        directParents:[],rootEvidence:[],
      });
    }
    const deriv=await a.getBoundedInspectionDerivedEvents('m',{limit:2});
    assert.equal(deriv.records.length,2);
    assert.equal(deriv.hasMore,true);
    assert.equal((await b.getBoundedInspectionDerivedEvents('m',{limit:2}))
      .records.length,0);

    const currentMatch=(id,scope,updatedAt)=>({
      matchId:id,triggerId:'t',triggerVersion:'1',
      status:'partial',partitionKey:null,
      openedAt:'2026-10-29T10:00:00.000Z',
      expiresAt:'2026-10-29T11:00:00.000Z',
      updatedAt,sourceEvents:[],semanticDecision:null,
      firedWakeId:null,derivedEventIds:[],
      schemaVersion:'trigger.v0.2',protocolVersion:'0.2.0',
    });
    await a.upsert('trigger_match','m1',currentMatch(
      'm1','a','2026-10-29T10:00:00.000Z'));
    await b.upsert('trigger_match','m1',currentMatch(
      'm1','b','2026-10-29T10:00:00.000Z'));
    await a.upsert('trigger_match','m2',currentMatch(
      'm2','a','2026-10-29T10:02:00.000Z'));
    const exact=await a.getBoundedInspectionMatch({
      triggerId:'t',version:'1',matchId:'m1'});
    assert.equal(exact.matchId,'m1');
    assert.equal((await a.getBoundedInspectionMatch({
      triggerId:'t',version:'1'})).matchId,'m2');
    assert.equal((await b.getBoundedInspectionMatch({
      triggerId:'t',version:'1'})).matchId,'m1');
    assert.equal(await a.getBoundedInspectionMatch({
      triggerId:'other',version:'1',matchId:'m1'}),null);
    await a.upsert('trigger_match','huge', {
      ...currentMatch('huge','a','2026-10-29T10:03:00.000Z'),
      sourceEvents:[{clauseId:'a',traceId:'trace',
        sourceEventId:'huge-source',eventName:'changed',
        serverId:'provider',occurredAt:'2026-10-29T10:03:00.000Z',
        data:{privatePayload:'S'.repeat(70000)}}],
    });
    await assert.rejects(()=>a.getBoundedInspectionMatch({
      triggerId:'t',version:'1',matchId:'huge',maxRowBytes:4096,
    }),e=>e?.code==='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED');
    await assert.rejects(()=>a.getBoundedInspectionMatch({
      triggerId:'t',version:'1',maxRowBytes:4096,
    }),e=>e?.code==='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED');

    await a.upsert('derived_event','large-row',{
      triggerId:'t',matchId:'huge-match',
      event:{name:'private-derivative',data:{secret:'S'.repeat(33000)}},
    });
    await assert.rejects(()=>a.getBoundedInspectionDerivedEvents('huge-match',
      {limit:2,maxRowBytes:4096}),e=>
        e?.code==='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED');
    for(const invalid of [0,101,1.5]){
      await assert.rejects(()=>a.getBoundedInspectionDeadlines('m',{limit:invalid}),
        /Invalid bounded inspection/);
    }
  }finally{
    for(const suffix of ['metadata','leases','history','records','counters']){
      await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    }
    await pool.end();
  }
});
