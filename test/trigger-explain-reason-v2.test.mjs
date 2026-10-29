import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyExplainReason } from '../scripts/lib/explain-reason-v2.mjs';
import { TriggerInspector } from '../scripts/lib/trigger-inspector.mjs';

const trigger={triggerId:'t',version:'1'};
const match={matchId:'m',triggerId:'t',triggerVersion:'1',status:'partial'};
function classify(input={}) {
  return classifyExplainReason({
    state:{status:'active'}, trigger, match, wake:null, ...input,
  });
}
function fact(kind,extra={}){
  return {contract:'ei.inspection-fact.v1',triggerId:'t',triggerVersion:'1',
    matchId:'m',durable:true,kind,...extra};
}
test('v2 distinguishes only local proven lifecycle and delivery outcomes',()=>{
  const cases=[
    [{state:{status:'paused'}},'paused'],
    [{state:{status:'expired'}},'lifecycle_ended'],
    [{match:{...match,status:'expired'}},'candidate_expired'],
    [{wake:{status:'dead_letter'}},'wake_failed'],
    [{match:{...match,status:'matched'}},'waiting_delivery'],
    [{match:{...match,status:'fired'}},'fired'],
    [{pendingDeadlines:[{status:'pending'}]},'deadline_pending'],
    [{match:null},'not_yet_satisfied'],
    [{},'not_yet_satisfied'],
  ];
  for(const [args,reason] of cases){
    const result=classify(args);
    assert.equal(result.kind,reason);
    assert.equal(result.contract,'ei.trigger-explain-reason.v2');
    assert.equal(result.upstreamCompleteness,'unknown');
    assert.equal(Object.isFrozen(result),true);
    assert.equal(result.basis,'persisted_local');
  }
});
test('scoped trusted store can carry durable facts without guessing upstream events',()=>{
  for(const reason of ['source_unavailable','watermark_pending','budget_truncated']){
    const result=classify({fact:fact(reason)});
    assert.equal(result.kind,reason);
    assert.equal(result.basis,'scoped_store_fact');
    assert.equal(result.upstreamCompleteness,'unknown');
  }
  assert.equal(classify({fact:fact('candidate_impossible',{terminal:true})}).kind,'candidate_impossible');
  assert.equal(classify({fact:fact('candidate_impossible')}).kind,'not_yet_satisfied');
  assert.equal(classify({match:null,fact:{...fact('candidate_impossible',{terminal:true}),matchId:null}}).kind,
    'not_yet_satisfied','absence of match cannot prove universal impossibility');
});
test('wrong-scope, undurable and untrusted facts never override persisted evidence',()=>{
  for(const bad of [
    fact('budget_truncated',{triggerId:'other'}),
    fact('source_unavailable',{triggerVersion:'2'}),
    fact('watermark_pending',{matchId:'foreign-match'}),
    fact('budget_truncated',{durable:false}),
    fact('unknown_reason'),
    fact('candidate_impossible',{terminal:false}),
    Object.defineProperty({},'kind',{get(){throw Error('unsafe getter')}}),
    new Proxy(fact('source_unavailable'),{get(){throw Error('untrusted proxy')}}),
  ]){
    assert.equal(classify({fact:bad}).kind,'not_yet_satisfied');
  }
  assert.equal(classify({state:{status:'paused'},fact:fact('watermark_pending')}).kind,'paused');
  assert.equal(classify({wake:{status:'dead_letter'},fact:fact('source_unavailable')}).kind,'wake_failed');
});
test('inspector reads scoped proof only through trusted store method, not source event payload',async()=>{
  const ref={clauseId:'a',traceId:'tr',sourceEventId:'src',serverId:'provider',
    eventName:'changed',occurredAt:'2026-10-29T12:00:00.000Z',
    data:{kind:'source_unavailable',token:'PRIVATE_HOST_SECRET'}};
  const record={...match,status:'partial',sourceEvents:[ref],updatedAt:'2026-10-29T12:00:00.000Z',
    openedAt:'2026-10-29T12:00:00.000Z',expiresAt:'2026-10-29T13:00:00.000Z',
    firedWakeId:null,derivedEventIds:[],patternState:null,partitionKey:null};
  const store={
    listTriggers:()=>[{...trigger,clauses:[{id:'a',event:'changed'}],
      pattern:{root:{kind:'event',ref:'a'}}}],
    getTriggerState:()=>({status:'active',fireCount:0}),
    listTriggerMatches:()=>[record],
    listTriggerMatchHistory:()=>[record],
    listTemporalDeadlines:()=>[],
    async getInspectionFact({triggerId,triggerVersion,matchId}) {
      assert.deepEqual({triggerId,triggerVersion,matchId},
        {triggerId:'t',triggerVersion:'1',matchId:'m'});
      return fact('source_unavailable');
    },
  };
  const a=await new TriggerInspector({store,matchHistoryLimit:1,evidenceRefLimit:1})
    .inspect({triggerId:'t',version:'1'});
  assert.equal(a.diagnosis.kind,'pattern_pending','v1 must not be broken');
  assert.equal(a.diagnosisV2.kind,'source_unavailable');
  assert.equal(a.diagnosisV2.basis,'scoped_store_fact');
  assert.equal(JSON.stringify(a).includes('PRIVATE_HOST_SECRET'),false);
  delete store.getInspectionFact;
  const b=await new TriggerInspector({store,matchHistoryLimit:1,evidenceRefLimit:1})
    .inspect({triggerId:'t',version:'1'});
  assert.equal(b.diagnosisV2.kind,'not_yet_satisfied');
  assert.equal(b.diagnosisV2.upstreamCompleteness,'unknown');
});
