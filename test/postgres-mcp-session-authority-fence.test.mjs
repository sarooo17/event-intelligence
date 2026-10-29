import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';

const url=process.env.POSTGRES_URL;
const {Pool}=url?await import('pg'):{Pool:null};
const integration=url?test:test.skip;
const token=(id)=>('host-owned-opaque-'+id).padEnd(48,'r');
const occurrence=id=>({
  eventId:id,name:'test.session.changed',
  timestamp:'2026-10-29T14:00:00.000Z',data:{safe:true},
});
const denied=e=>e?.code==='MCP_SESSION_REVOKED';
async function fixture(run){
  const prefix='ei_authority_'+randomBytes(5).toString('hex');
  const poolA=new Pool({connectionString:url,max:4,statement_timeout:10000});
  const poolB=new Pool({connectionString:url,max:4,statement_timeout:10000});
  const make=(pool,scopeId='tenant-a')=>new PostgresEventStore({
    pool,tablePrefix:prefix,scopeId,
    dispatchPoolIdentity:pool,requireMcpSessionFence:true,
  });
  const a=make(poolA),b=make(poolB),other=make(poolB,'tenant-b');
  try{
    await Promise.all([a.init(),b.init(),other.init()]);
    await run({a,b,other});
  }finally{
    try{for(const suffix of ['metadata','leases','history','records','counters']){
      await poolA.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    }}finally{await Promise.allSettled([poolA.end(),poolB.end()])}
  }
}
integration('PG16 two independent pools: revoke fences old epoch, rebind permits new one without cross-scope spill',()=>fixture(async({a,b,other})=>{
  const old=token('old'),fresh=token('fresh');
  await assert.rejects(
    a.appendMcpOccurrence('provider',occurrence('before-register'),'sub'),
    e=>e.code==='MCP_SESSION_AUTHORITY_INVALID'
  );
  await a.beginMcpConnectionAuthority({connectionId:'c',epoch:old});
  assert.equal((await b.appendMcpOccurrence('provider',occurrence('first'),'sub',{
    connectionId:'c',epoch:old,
  })).accepted,true);
  assert.equal(await b.revokeMcpConnectionAuthority({connectionId:'c',epoch:old}),true);
  await assert.rejects(a.appendMcpOccurrence('provider',occurrence('revoked'),'sub',{
    connectionId:'c',epoch:old,
  }),denied);
  await assert.rejects(a.beginMcpConnectionAuthority({
    connectionId:'c',epoch:old,
  }),denied);
  await b.beginMcpConnectionAuthority({connectionId:'c',epoch:fresh});
  assert.equal(await a.revokeMcpConnectionAuthority({connectionId:'c',epoch:old}),false,
    'late old-session revoke may not disable same-ID fresh host session');
  await assert.rejects(a.appendMcpOccurrence('provider',occurrence('stale'),'sub',{
    connectionId:'c',epoch:old,
  }),denied);
  assert.equal((await a.appendMcpOccurrence('provider',occurrence('fresh'),'sub',{
    connectionId:'c',epoch:fresh,
  })).accepted,true);
  await assert.rejects(other.appendMcpOccurrence('provider',occurrence('foreign'),'sub',{
    connectionId:'c',epoch:fresh,
  }),denied);
  assert.equal(await b.revokeMcpConnectionAuthority({connectionId:'c',epoch:fresh}),true);
  // Regression: retired A must stay revoked even after B supersedes it and
  // B is itself revoked. A→B→A reactivation would bypass revocation.
  await assert.rejects(a.beginMcpConnectionAuthority({
    connectionId:'c',epoch:old,
  }),denied);
  await assert.rejects(b.appendMcpOccurrence('provider',occurrence('late'),'sub',{
    connectionId:'c',epoch:fresh,
  }),denied);
  const checkpoint=await a.getMcpOccurrenceArchiveCheckpoint();
  assert.equal(checkpoint.endSequence,2);
}));
integration('PG16 accepted append transaction linearizes before remote revoke; later append denies',()=>fixture(async({a,b})=>{
  const epoch=token('race');
  await a.beginMcpConnectionAuthority({connectionId:'race',epoch});
  let entered,release;
  const hit=new Promise(resolve=>{entered=resolve});
  const gate=new Promise(resolve=>{release=resolve});
  const upsert=a.upsert.bind(a);
  a.upsert=async(kind,key,payload,client)=>{
    if(kind==='mcp_occurrence_key'){entered();await gate;}
    return upsert(kind,key,payload,client);
  };
  const admitted=a.appendMcpOccurrence('provider',occurrence('admitted'),'sub',{
    connectionId:'race',epoch,
  });
  await hit; // append holds its transaction-scoped shared authority lock
  let revoked=false;
  const revoke=b.revokeMcpConnectionAuthority({
    connectionId:'race',epoch,
  }).then(v=>{revoked=v;return v});
  await Promise.resolve();
  assert.equal(revoked,false);
  release();
  assert.equal((await admitted).accepted,true);
  assert.equal(await revoke,true);
  await assert.rejects(a.appendMcpOccurrence('provider',occurrence('late'),'sub',{
    connectionId:'race',epoch,
  }),denied);
  const checkpoint=await b.getMcpOccurrenceArchiveCheckpoint();
  assert.equal(checkpoint.endSequence,1);
}));

integration('PG16 revoke-before-begin permanently tombstones delayed registration',()=>fixture(async({a,b,other})=>{
  const neverRegistered=token('never-registered');
  assert.equal(await a.revokeMcpConnectionAuthority({
    connectionId:'early',epoch:neverRegistered,
  }),false);
  await assert.rejects(b.beginMcpConnectionAuthority({
    connectionId:'early',epoch:neverRegistered,
  }),denied);
  await assert.rejects(b.appendMcpOccurrence('provider',occurrence('early-rejected'),'sub',{
    connectionId:'early',epoch:neverRegistered,
  }),denied);
  const first=token('current-active'),conflicting=token('conflicting');
  await a.beginMcpConnectionAuthority({connectionId:'reused',epoch:first});
  await assert.rejects(b.beginMcpConnectionAuthority({
    connectionId:'reused',epoch:conflicting,
  }),e=>e.code==='MCP_SESSION_EPOCH_CONFLICT');
  // The failed B registration is revocable even while A stays active.
  assert.equal(await b.revokeMcpConnectionAuthority({
    connectionId:'reused',epoch:conflicting,
  }),false);
  assert.equal((await a.appendMcpOccurrence('provider',occurrence('A-still-active'),'sub',{
    connectionId:'reused',epoch:first,
  })).accepted,true);
  assert.equal(await a.revokeMcpConnectionAuthority({
    connectionId:'reused',epoch:first,
  }),true);
  await assert.rejects(b.beginMcpConnectionAuthority({
    connectionId:'reused',epoch:conflicting,
  }),denied);
  await assert.rejects(b.beginMcpConnectionAuthority({
    connectionId:'reused',epoch:first,
  }),denied);
  const fresh=token('after-tombstones');
  await b.beginMcpConnectionAuthority({connectionId:'reused',epoch:fresh});
  await assert.rejects(other.appendMcpOccurrence('provider',occurrence('foreign-replay'),'sub',{
    connectionId:'reused',epoch:fresh,
  }),denied);
}));
