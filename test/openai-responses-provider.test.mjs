import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes,createHash} from 'node:crypto';
import {PostgresEventStore} from '../scripts/lib/postgres-event-store.mjs';
import {
  createOpenAIResponsesValidationTransport,runOpenAIResponsesValidationCase,
} from '../scripts/validation/openai-responses-provider.mjs';

const url=process.env.POSTGRES_URL;
const pg=url?await import('pg'):null;
const Pool=pg?.Pool??pg?.default?.Pool;
const integration=url?test:test.skip;
const prefix='ei_openai_validation_'+randomBytes(5).toString('hex');

function modelResponse(id='resp_mock123456'){
  return {id,model:'gpt-4o-mini',status:'completed',
    max_output_tokens:32,usage:{input_tokens:9,output_tokens:12,
      input_tokens_details:{cached_tokens:0},
      output_tokens_details:{reasoning_tokens:0}}};
}
function mockProvider({
  preflightTokens=9,output=()=>modelResponse(),
  fetched=()=>modelResponse(),throwOnCreate=false,
}={}){
  const calls=[];
  const fakeFetch=async (url,init)=>{
    const path=new URL(url).pathname;
    calls.push({path,method:init.method,body:init.body,
      hasAuth:init.headers.authorization==='Bearer isolated-test-key'});
    if(path.endsWith('/input_tokens'))
      return {ok:true,json:async()=>({input_tokens:preflightTokens})};
    if(init.method==='GET'&&path.startsWith('/v1/responses/'))
      return {ok:true,json:async()=>fetched()};
    if(init.method==='POST'&&path==='/v1/responses'){
      if(throwOnCreate)throw new Error('private provider request payload');
      return {ok:true,json:async()=>output()};
    }
    if(init.method==='POST'&&path.endsWith('/cancel'))
      return {ok:true,json:async()=>({status:'cancelled'})};
    return {ok:false,status:404,json:async()=>({detail:'secret'})};
  };
  return {calls,transport:createOpenAIResponsesValidationTransport({
    apiKey:'isolated-test-key',fetchImpl:fakeFetch,requestTimeoutMs:1000,
  })};
}
test('provider transport uses fixed HTTPS, bounded response and safe errors',async()=>{
  const {transport,calls}=mockProvider();
  assert.equal(await transport.countInput('gpt-4o-mini','short ticket'),9);
  const r=await transport.create({model:'gpt-4o-mini',input:'short ticket',
    maxOutputTokens:32});
  assert.equal(r.id,'resp_mock123456');
  assert.equal(calls[1].path,'/v1/responses');
  const sent=JSON.parse(calls[1].body);
  assert.equal(sent.max_output_tokens,32);
  assert.equal(sent.truncation,'disabled');
  assert.equal(sent.store,true);
  assert.deepEqual(sent.tools,[]);
  assert.equal(sent.background,false);
  assert(calls.every(c=>c.hasAuth));
  await transport.retrieve(r.id);
  await transport.cancelBackground(r.id);
  await assert.rejects(()=>transport.retrieve('https://evil'),/Untrusted response ID/);
  const failed=mockProvider({throwOnCreate:true});
  await assert.rejects(()=>failed.transport.create({
    model:'gpt-4o-mini',input:'short',maxOutputTokens:32,
  }),err=>err.code==='EI_OPENAI_REMOTE_OUTCOME_UNKNOWN' &&
    !String(err).includes('private provider request payload'));
  assert.throws(()=>createOpenAIResponsesValidationTransport({
    apiKey:'x',fetchImpl:()=>{},requestTimeoutMs:50000}),/bounded/);
});
test('provider validation refuses excess input before any billable request',async()=>{
 const {transport,calls}=mockProvider({preflightTokens:1000});
 const report=await runOpenAIResponsesValidationCase({
   store:{},transport,batchId:'dryrun',reservationId:'not-used',
   maxInputTokens:64});
 assert.deepEqual(report,{status:'input_preflight_refused',providerRequests:0});
 assert.equal(calls.filter(x=>x.path==='/v1/responses').length,0);
 await assert.rejects(()=>runOpenAIResponsesValidationCase({
   store:{},transport,batchId:'dryrun',reservationId:'not-used',
   model:'unsafe-provider-model',maxInputTokens:64}),/Invalid bounded/);
});
integration('real PG16 admission, GET-confirmed usage, duplicate refusal and no invoice claim',async()=>{
  const pa=new Pool({connectionString:url,max:3});
  const pb=new Pool({connectionString:url,max:3});
  const a=new PostgresEventStore({pool:pa,dispatchPoolIdentity:pa,
    scopeId:'openai-valid-A',tablePrefix:prefix});
  const b=new PostgresEventStore({pool:pb,dispatchPoolIdentity:pb,
    scopeId:'openai-valid-A',tablePrefix:prefix});
  try{
    await a.init();await b.init();
    const {transport,calls}=mockProvider();
    const args={store:a,transport,batchId:'episode-1',
      budgetEpoch:'policy-1',reservationId:'intent-1'};
    const result=await runOpenAIResponsesValidationCase(args);
    assert.equal(result.status,'usage_observed_billing_unknown');
    assert.equal(result.providerRequests,1);
    assert.equal(result.withinReservedTokens,true);
    assert.equal(result.billingConfirmed,false);
    assert.equal(result.inputTokens,9);
    assert.equal(calls.filter(x=>x.path==='/v1/responses').length,1);
    assert.equal(calls.filter(x=>x.method==='GET').length,1);
    assert(!JSON.stringify(result).includes('resp_mock123456'));
    const restarted=await runOpenAIResponsesValidationCase({
      ...args,store:b});
    assert.equal(restarted.status,'admission_denied');
    assert.equal(restarted.providerRequests,0);
    assert.equal(calls.filter(x=>x.path==='/v1/responses').length,1);
    const key='reservation:'+JSON.stringify([
      'ei-provider-validation@1','policy-1',
      createHash('sha256').update('intent-1').digest('hex')]);
    const row=await b.get('semantic_budget_receipt',key);
    assert.equal(row.status,'usage_observed_billing_unknown');
    assert.equal(row.billingConfirmed,false);
    const ledger=await a.get('semantic_budget','trigger:'+JSON.stringify([
      'ei-provider-validation@1','policy-1']));
    assert.equal(ledger.calls,1);
    assert.equal(ledger.tokens,41);
    assert.equal(ledger.costMicros,100000);
  }finally{
    for(const suffix of ['metadata','leases','history','records','counters']){
      await pa.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    }
    await pa.end();await pb.end();
  }
});
integration('real PG16 incompletely generated OpenAI response: GET-verified usage kept, no semantic completion or refund',async()=>{
  const pool=new Pool({connectionString:url,max:3});
  const db=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
    scopeId:'openai-incomplete',tablePrefix:prefix});
  try{
    await db.init();
    const incomplete=()=>({...modelResponse('resp_incomplete123456'),
      status:'incomplete',incomplete_details:{reason:'max_output_tokens'}});
    const {transport,calls}=mockProvider({output:incomplete,fetched:incomplete});
    const opts={store:db,transport,batchId:'incomplete-batch',
      budgetEpoch:'incomplete-epoch',reservationId:'incomplete-once'};
    const first=await runOpenAIResponsesValidationCase(opts);
    assert.equal(first.status,'incomplete_usage_observed_billing_unknown');
    assert.equal(first.providerResponseStatus,'incomplete');
    assert.equal(first.providerResponseCompleted,false);
    assert.equal(first.providerRequests,1);
    assert.equal(first.billingConfirmed,false);
    assert.equal(first.withinReservedTokens,true);
    assert.equal(first.inputTokens,9);
    assert.equal(first.outputTokens,12);
    assert.equal(calls.filter(x=>x.method==='GET').length,1,
      'terminal incomplete usage must be checked on provider GET');
    assert(!JSON.stringify(first).includes('resp_incomplete123456'));
    const key='reservation:'+JSON.stringify([
      'ei-provider-validation@1','incomplete-epoch',
      createHash('sha256').update('incomplete-once').digest('hex')]);
    const saved=await db.get('semantic_budget_receipt',key);
    assert.equal(saved.status,'usage_observed_billing_unknown');
    assert.equal(saved.billingConfirmed,false);
    const budget=await db.get('semantic_budget','trigger:'+JSON.stringify([
      'ei-provider-validation@1','incomplete-epoch']));
    assert.equal(budget.calls,1);
    assert.equal(budget.tokens,41);
    assert.equal(budget.costMicros,100000);
    const replay=await runOpenAIResponsesValidationCase(opts);
    assert.equal(replay.status,'admission_denied');
    assert.equal(replay.providerRequests,0);
    assert.equal(calls.filter(x=>x.method==='POST'&&x.path==='/v1/responses').length,1);
  }finally{
    for(const suffix of ['metadata','leases','history','records','counters'])
      await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    await pool.end();
  }
});
integration('incomplete provider GET disagreement remains unknown; queued status never acquires semantic completion',async()=>{
  const pool=new Pool({connectionString:url,max:3});
  const db=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
    scopeId:'openai-incomplete-invalid',tablePrefix:prefix});
  try{
    await db.init();
    const incomplete=()=>({...modelResponse('resp_incomplete_other123'),
      status:'incomplete'});
    const mismatch=mockProvider({output:incomplete,fetched:()=>modelResponse(
      'resp_incomplete_other123')});
    const opts={store:db,transport:mismatch.transport,
      batchId:'incomplete-mismatch',budgetEpoch:'incomplete-mismatch-1',
      reservationId:'incomplete-mismatch-1'};
    const result=await runOpenAIResponsesValidationCase(opts);
    assert.equal(result.status,'remote_reconciliation_unknown');
    assert.equal(result.providerResponseStatus,'incomplete');
    assert.equal(result.reservationRetained,true);
    assert.equal(result.billingConfirmed,false);
    assert.equal((await runOpenAIResponsesValidationCase(opts)).status,
      'admission_denied');
    assert.equal(mismatch.calls.filter(x=>x.method==='POST'&&
      x.path==='/v1/responses').length,1);
    const queued=mockProvider({output:()=>({
      ...modelResponse('resp_queued123456'),status:'queued',
    })});
    const pending=await runOpenAIResponsesValidationCase({
      store:db,transport:queued.transport,batchId:'queued-batch',
      budgetEpoch:'queued-epoch',reservationId:'queued-once'});
    assert.equal(pending.status,'remote_usage_unknown');
    assert.equal(pending.providerResponseStatus,'queued');
    assert.equal(pending.providerUsagePresent,true);
    assert.equal(pending.reservationRetained,true);
    assert.equal(queued.calls.filter(x=>x.method==='GET').length,0);
    assert.equal((await runOpenAIResponsesValidationCase({
      store:db,transport:queued.transport,batchId:'queued-batch',
      budgetEpoch:'queued-epoch',reservationId:'queued-once'})).status,
    'admission_denied');
  }finally{
    for(const suffix of ['metadata','leases','history','records','counters'])
      await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    await pool.end();
  }
});

integration('mismatched provider GET and network uncertainty preserve reserved quota',async()=>{
  const pool=new Pool({connectionString:url,max:3});
  const db=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
    scopeId:'openai-valid-B',tablePrefix:prefix});
  try{
    await db.init();
    const mismatch=mockProvider({fetched:()=>modelResponse(
      'resp_another12345')});
    const opts={store:db,transport:mismatch.transport,
      batchId:'b1',budgetEpoch:'mismatch-1',reservationId:'mismatch-1'};
    const result=await runOpenAIResponsesValidationCase(opts);
    assert.equal(result.status,'remote_reconciliation_unknown');
    assert.equal(result.billingConfirmed,false);
    const digest=createHash('sha256').update('mismatch-1').digest('hex');
    const r=await db.get('semantic_budget_receipt','reservation:'+JSON.stringify([
      'ei-provider-validation@1','mismatch-1',digest]));
    assert.equal(r.status,'reserved_billing_unknown');
    assert.equal(await runOpenAIResponsesValidationCase(opts).then(
      x=>x.status),'admission_denied');
    const timed=mockProvider({throwOnCreate:true});
    const unknown=await runOpenAIResponsesValidationCase({
      store:db,transport:timed.transport,
      batchId:'b2',budgetEpoch:'unknown-2',reservationId:'timeout-2',
    });
    assert.equal(unknown.status,'remote_billing_unknown');
    assert.equal(unknown.reservationRetained,true);
    assert.equal(timed.calls.filter(x=>x.path==='/v1/responses').length,1);
  }finally{
    for(const suffix of ['metadata','leases','history','records','counters']){
      await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    }
    await pool.end();
  }
});


integration('separate PG16 workers racing one bounded semantic intent emit at most one provider request',async()=>{
  const pa=new Pool({connectionString:url,max:3});
  const pb=new Pool({connectionString:url,max:3});
  const a=new PostgresEventStore({pool:pa,dispatchPoolIdentity:pa,
    scopeId:'openai-race',tablePrefix:prefix});
  const b=new PostgresEventStore({pool:pb,dispatchPoolIdentity:pb,
    scopeId:'openai-race',tablePrefix:prefix});
  try{
    await a.init();await b.init();
    const {transport,calls}=mockProvider();
    const run=(store)=>runOpenAIResponsesValidationCase({
      store,transport,batchId:'race-batch',
      budgetEpoch:'race-epoch',reservationId:'same-host-intent',
    });
    const [left,right]=await Promise.all([run(a),run(b)]);
    assert.deepEqual([left.status,right.status].sort(),
      ['admission_denied','usage_observed_billing_unknown'].sort());
    assert.equal(calls.filter(c=>c.method==='POST'&&c.path==='/v1/responses').length,1);
    assert.equal((await a.get('semantic_budget',
      'trigger:'+JSON.stringify(['ei-provider-validation@1','race-epoch']))).calls,1);
    // A different intent is rejected by the hard call/cost cap too.
    assert.equal((await runOpenAIResponsesValidationCase({
      store:b,transport,batchId:'race-batch',budgetEpoch:'race-epoch',
      reservationId:'other-intent',
    })).status,'admission_denied');
  }finally{
    for(const suffix of ['metadata','leases','history','records','counters'])
      await pa.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    await pa.end();await pb.end();
  }
});

integration('adversarial provider reports more output tokens than reserved without crediting or declaring invoice confirmed',async()=>{
  const pool=new Pool({connectionString:url,max:3});
  const db=new PostgresEventStore({pool,dispatchPoolIdentity:pool,
    scopeId:'openai-excess',tablePrefix:prefix});
  try{
    await db.init();
    const excess=()=>({...modelResponse('resp_excess123456'),
      usage:{input_tokens:9,output_tokens:50,
        input_tokens_details:{cached_tokens:0},
        output_tokens_details:{reasoning_tokens:0}}});
    const {transport,calls}=mockProvider({output:excess,fetched:excess});
    const opts={store:db,transport,batchId:'excess-batch',
      budgetEpoch:'excess-epoch',reservationId:'excess-intent'};
    const r=await runOpenAIResponsesValidationCase(opts);
    assert.equal(r.status,'usage_exceeds_reservation');
    assert.equal(r.withinReservedTokens,false);
    assert.equal(r.billingConfirmed,false);
    assert.equal(r.reservationRetained,true);
    assert.equal((await db.get('semantic_budget',
      'trigger:'+JSON.stringify(['ei-provider-validation@1','excess-epoch']))).tokens,41);
    assert.equal((await runOpenAIResponsesValidationCase(opts)).status,'admission_denied');
    assert.equal(calls.filter(c=>c.path==='/v1/responses').length,1);
  }finally{
    for(const suffix of ['metadata','leases','history','records','counters'])
      await pool.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    await pool.end();
  }
});

integration('v1 timeout: unknown remote charge cannot free trigger or batch admission across workers',async()=>{
  const pa=new Pool({connectionString:url,max:2});
  const pb=new Pool({connectionString:url,max:2});
  const a=new PostgresEventStore({pool:pa,dispatchPoolIdentity:pa,
    scopeId:'openai-v1-uncertain-gate',tablePrefix:prefix});
  const b=new PostgresEventStore({pool:pb,dispatchPoolIdentity:pb,
    scopeId:'openai-v1-uncertain-gate',tablePrefix:prefix});
  try{
    await a.init();await b.init();
    const {transport,calls}=mockProvider({throwOnCreate:true});
    const opts={store:a,transport,batchId:'one-shot-unknown',
      budgetEpoch:'explicit-policy-1',reservationId:'possibly-billed-call-1'};
    const uncertain=await runOpenAIResponsesValidationCase(opts);
    assert.equal(uncertain.status,'remote_billing_unknown');
    assert.equal(uncertain.reservationRetained,true);
    assert.equal(uncertain.providerRequests,1);
    for(const candidate of [
      {...opts,store:b},
      {...opts,store:b,reservationId:'new-intent-same-batch'},
      {...opts,store:b,batchId:'different-batch',
        reservationId:'new-intent-different-batch'},
    ]){
      const denied=await runOpenAIResponsesValidationCase(candidate);
      assert.equal(denied.status,'admission_denied');
      assert.equal(denied.providerRequests,0);
    }
    assert.equal(calls.filter(x=>x.path==='/v1/responses').length,1);
    const trigger=await b.get('semantic_budget',
      'trigger:'+JSON.stringify(['ei-provider-validation@1','explicit-policy-1']));
    assert.equal(trigger.calls,1);
    assert.equal(trigger.costMicros,100000);
    const receipt=await b.get('semantic_budget_receipt',
      'reservation:'+JSON.stringify(['ei-provider-validation@1',
        'explicit-policy-1',
        createHash('sha256').update('possibly-billed-call-1').digest('hex')]));
    assert.equal(receipt.status,'reserved_billing_unknown');
    // Only a new explicit host policy epoch can authorize another
    // potentially chargeable request, never a silent retry.
    const separate=await runOpenAIResponsesValidationCase({
      ...opts,store:b,batchId:'operator-authorized-next',
      budgetEpoch:'explicit-policy-2',reservationId:'operator-new-intent'});
    assert.equal(separate.status,'remote_billing_unknown');
    assert.equal(calls.filter(x=>x.path==='/v1/responses').length,2);
  }finally{
    for(const suffix of ['metadata','leases','history','records','counters'])
      await pa.query('DROP TABLE IF EXISTS "'+prefix+'_'+suffix+'" CASCADE');
    await pa.end();await pb.end();
  }
});
