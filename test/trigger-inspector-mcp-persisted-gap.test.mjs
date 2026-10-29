import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PersistentEventStore} from '../scripts/lib/persistent-event-store.mjs';
import {TriggerInspector} from '../scripts/lib/trigger-inspector.mjs';
const trigger={triggerId:'guarded-gap',version:'1',clauses:[
  {id:'a',event:'delivery.changed',serverId:'provider',arguments:{},where:[]},
],pattern:{version:'2',root:{kind:'event',ref:'a'}},
withinMs:60000,target:{runtime:'host',kind:'task',id:'one'}};
const source={sourceId:'source-1',connectionId:'c1',serverId:'provider',
  eventName:'delivery.changed',delivery:['poll'],enabled:true};
const args={connectionId:'c1',serverId:'provider',
  eventName:'delivery.changed',arguments:{},truncated:true};
async function setup(store) {
  await store.putTrigger(trigger);
  await store.setTriggerState('guarded-gap','1','active',null,
    {connectionIds:['c1'],owner:{type:'user',principal_id:'owner',tenant_id:'t'}});
  await store.putEventSource(source);
}
test('real JSONL durable MCP truncated page is explained as gap after restart and then reconciles',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-explain-gap-'));
  let store=new PersistentEventStore(dir);
  try{
    await store.init();await setup(store);
    const baseline=await new TriggerInspector({store}).inspect({triggerId:'guarded-gap',version:'1'});
    assert.equal(baseline.diagnosisV2.kind,'not_yet_satisfied');
    const persisted=await store.putMcpClientState(args);
    assert.equal(persisted.gapUnresolved,true);
    const pending=await new TriggerInspector({store}).inspect({triggerId:'guarded-gap',version:'1'});
    assert.equal(pending.diagnosisV2.kind,'source_gap_unresolved');
    assert.equal(pending.diagnosisV2.basis,'scoped_store_fact');
    assert.equal(pending.diagnosisV2.upstreamCompleteness,'unknown');
    await store.close();
    store=new PersistentEventStore(dir);await store.init();
    const reloaded=await new TriggerInspector({store}).inspect({triggerId:'guarded-gap',version:'1'});
    assert.deepEqual(reloaded.diagnosisV2,pending.diagnosisV2);
    // A later healthy poll cannot certify earlier missing events.
    const healthy=await store.putMcpClientState({...args,truncated:false});
    assert.equal(healthy.gapUnresolved,true);
    assert.equal((await new TriggerInspector({store}).inspect({
      triggerId:'guarded-gap',version:'1'})).diagnosisV2.kind,'source_gap_unresolved');
    const reconciled=await store.putMcpClientState({
      ...args,truncated:false,gapReconciled:true,
      expectedCompletenessRevision:healthy.completenessRevision,
      reconciliationEvidenceId:'host-owned-gap-replay-proof',
    });
    assert.equal(reconciled.gapUnresolved,false);
    assert.equal((await new TriggerInspector({store}).inspect({
      triggerId:'guarded-gap',version:'1'})).diagnosisV2.kind,'not_yet_satisfied');
    // A no-longer-authorized source or a different trigger cannot contribute.
    await store.putEventSource({...source,enabled:false});
    await store.putMcpClientState(args);
    assert.equal((await new TriggerInspector({store}).inspect({
      triggerId:'guarded-gap',version:'1'})).diagnosisV2.kind,'not_yet_satisfied');
  }finally{
    try{await store.close();}finally{await rm(dir,{recursive:true,force:true});}
  }
});

test('real canonical evaluator truncation is audit-persisted, stable after restart and not stale',async()=>{
  const {evaluatePatternV2,PatternAstV2DefinitionSchema}=await import(
    '../dist/src/intelligenceProtocol/index.js');
  const now='2026-10-29T10:00:00.000Z';
  const ast=PatternAstV2DefinitionSchema.parse({
    version:'2',
    root:{kind:'sequence',contiguity:'next',children:[
      {kind:'anyOf',children:[{kind:'event',ref:'a'},{kind:'event',ref:'z'}]},
      {kind:'event',ref:'b'},
    ]},
    partitionBy:[],
    selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:100},
    execution:{maxCandidates:2,maxSemanticEvaluations:0,maxBufferedEvents:16},
  });
  const events=['a','a','z','b'].map((ref,i)=>({
    clauseId:ref,sourceEventId:'evt-'+i,traceId:'trace-'+i,
    eventName:ref,occurredAt:new Date(Date.parse(now)+i*1000).toISOString(),
    serverId:'provider',subscriptionArguments:{},data:{},
  }));
  const evaluated=await evaluatePatternV2({definition:ast,events});
  assert.equal(evaluated.truncated,true,'must be a real evaluator budget exhaustion');
  assert.equal(evaluated.matches.length,0);
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-explain-budget-audit-'));
  let store=new PersistentEventStore(dir);
  const partial={
    protocolVersion:'0.2.0',schemaVersion:'trigger.v0.2',
    matchId:'candidate',triggerId:'guarded-gap',triggerVersion:'1',
    status:'partial',openedAt:now,updatedAt:now,
    expiresAt:'2026-10-29T11:00:00.000Z',
    partitionKey:null,sourceEvents:[],
    semanticDecision:null,firedWakeId:null,derivedEventIds:[],
  };
  try{
    await store.init();await setup(store);
    await store.appendTriggerMatch(partial);
    await store.appendAudit({
      auditId:'audit-budget-one',traceId:'trace',
      timestamp:now,kind:'trigger.partial',entityType:'trigger_match',
      entityId:'candidate',
      details:{triggerId:'guarded-gap',triggerVersion:'1',
        truncated:evaluated.truncated},
    });
    const explain=()=>new TriggerInspector({store})
      .inspect({triggerId:'guarded-gap',version:'1',matchId:'candidate'});
    assert.equal((await explain()).diagnosisV2.kind,'budget_truncated');
    await store.close();
    store=new PersistentEventStore(dir);await store.init();
    assert.equal((await explain()).diagnosisV2.kind,'budget_truncated');
    await store.appendAudit({
      auditId:'audit-budget-two',traceId:'trace',
      timestamp:'2026-10-29T10:00:01.000Z',
      kind:'trigger.partial',entityType:'trigger_match',entityId:'candidate',
      details:{triggerId:'guarded-gap',triggerVersion:'1',truncated:false},
    });
    assert.equal((await explain()).diagnosisV2.kind,'not_yet_satisfied',
      'old evaluator exhaustion cannot override a newer complete evaluation');
    assert.equal(await store.verifyAudit(),true);
  }finally{
    try{await store.close();}finally{await rm(dir,{recursive:true,force:true});}
  }
});
