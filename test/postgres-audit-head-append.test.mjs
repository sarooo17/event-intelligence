import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
import {AuditChain} from '../dist/src/intelligenceProtocol/index.js';

const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;

function record(i){
 return {auditId:'audit-head-'+i,traceId:'trace-head',
  timestamp:new Date(Date.UTC(2026,10,3,11,0,i)).toISOString(),
  kind:'trigger.created',entityType:'trigger',
  entityId:'trigger-head-'+i,details:{ordinal:i}};
}

integration('concurrent PG16 audit head append preserves canonical chain, scope isolation and tamper refusal',async()=>{
 const prefix='ei_audhead_'+randomBytes(5).toString('hex');
 const poolA=new Pool({connectionString:url,max:4});
 const poolB=new Pool({connectionString:url,max:4});
 const options={tablePrefix:prefix};
 const a=new PostgresEventStore({...options,pool:poolA,
  dispatchPoolIdentity:poolA,scopeId:'audit-head-A'});
 const b=new PostgresEventStore({...options,pool:poolB,
  dispatchPoolIdentity:poolB,scopeId:'audit-head-A'});
 const other=new PostgresEventStore({...options,pool:poolB,
  dispatchPoolIdentity:poolB,scopeId:'audit-head-B'});
 const table='"'+prefix+'_history"';
 try{
  await Promise.all([a.init(),b.init(),other.init()]);
  const writes=Array.from({length:60},(_,i)=>
   (i%2?b:a).appendAudit(record(i)));
  await Promise.all(writes);
  const actual=await a.listAudit();
  assert.equal(actual.length,60);
  assert.deepEqual(actual.map(x=>x.sequence),
   Array.from({length:60},(_,i)=>i));
  const chain=new AuditChain();
  for(const row of actual){
   const i=Number(row.auditId.replace('audit-head-',''));
   const expected=await chain.append(record(i));
   assert.deepEqual(row,expected);
  }
  assert.equal(await chain.verify(),true);
  assert.equal(await a.verifyAudit(),true);
  const checkpoint=await b.getAuditCheckpoint();
  assert.equal(checkpoint.endSequence,59);
  assert.equal(checkpoint.headHash,actual.at(-1).hash);
  await other.appendAudit(record(80));
  assert.equal((await other.listAudit())[0].sequence,0);
  assert.equal((await b.listAudit()).length,60);

  // Fail closed if the stored physical tail was changed without rehashing.
  const tail=(await poolA.query('SELECT history_id,payload FROM '+table+
   ' WHERE scope_id=$1 AND kind=$2 ORDER BY history_id DESC LIMIT 1',
   ['audit-head-A','audit'])).rows[0];
  assert.equal(tail.payload.hash,actual.at(-1).hash);
  const damaged={...tail.payload,details:{...tail.payload.details,tampered:true}};
  try{
   await poolA.query('UPDATE '+table+' SET payload=$1::jsonb WHERE history_id=$2',
    [JSON.stringify(damaged),tail.history_id]);
   await assert.rejects(b.appendAudit(record(61)),e=>
    e?.code==='EVENT_INTELLIGENCE_AUDIT_HEAD_CORRUPTED');
   assert.equal(await a.verifyAudit(),false);
  }finally{
   await poolA.query('UPDATE '+table+' SET payload=$1::jsonb WHERE history_id=$2',
    [JSON.stringify(tail.payload),tail.history_id]);
  }
  // PostgreSQL JSONB NOT NULL still permits JSON null, booleans, numbers
  // and strings. None may be misinterpreted as an absent audit predecessor.
  for(const invalid of [null,false,0,'']){
   try{
    await poolA.query('UPDATE '+table+' SET payload=$1::jsonb WHERE history_id=$2',
     [JSON.stringify(invalid),tail.history_id]);
    await assert.rejects(b.appendAudit(record(61)));
    const remaining=(await poolA.query('SELECT count(*)::integer AS n FROM '+
     table+' WHERE scope_id=$1 AND kind=$2',['audit-head-A','audit'])).rows[0].n;
    assert.equal(remaining,60);
   }finally{
    await poolA.query('UPDATE '+table+' SET payload=$1::jsonb WHERE history_id=$2',
     [JSON.stringify(tail.payload),tail.history_id]);
   }
  }
  // A regression to full-history scan would fail this test even on a tiny
  // fixture; the production fast path must use only the index-backed tail.
  const originalHistoryList=a.historyList.bind(a);
  a.historyList=(kind,...rest)=>{
   if(kind==='audit')throw Error('O_N_AUDIT_HISTORY_HOT_PATH');
   return originalHistoryList(kind,...rest);
  };
  const resumed=await a.appendAudit(record(62));
  assert.equal(resumed.sequence,60);
  assert.equal(resumed.previousHash,actual.at(-1).hash);
  assert.equal(await b.verifyAudit(),true);
  const finalCheckpoint=await b.getAuditCheckpoint();
  assert.equal(finalCheckpoint.endSequence,60);
  assert.equal(finalCheckpoint.headHash,resumed.hash);
 }finally{
  for(const suffix of ['metadata','leases','history','records','counters'])
   await poolA.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
  await Promise.all([poolA.end(),poolB.end()]);
 }
});
