import assert from 'node:assert/strict';
import test from 'node:test';
import { TriggerInspector } from '../scripts/lib/trigger-inspector.mjs';

const now='2026-10-16T10:00:00.000Z';
const rawSecret='should-never-be-in-any-diagnosis';
function fixture({state='active',matchStatus='partial',wakeStatus=null,
  pendingDeadline=false,withMatch=true,conditionOnly=false}={}){
  const source={
    clauseId:'a',serverId:'github',eventName:'issue.updated',
    sourceEventId:'issue-1',traceId:'trace-1',
    occurredAt:now,data:{sensitive:rawSecret},
  };
  const match={
    matchId:'match-1',triggerId:'observe',triggerVersion:'1',
    status:matchStatus,updatedAt:now,openedAt:now,
    expiresAt:'2026-10-16T12:00:00.000Z',
    sourceEvents:[source],partitionKey:null,
    firedWakeId:wakeStatus?'wake-1':null,
    derivedEventIds:[],patternState:{version:'2',role:'buffer',semanticDecisions:[]},
  };
  const store={
    listTriggers:()=>[{
      triggerId:'observe',version:'1',conditionOnly,
      ...(conditionOnly?{}:{target:{runtime:'test',kind:'task',id:'x'}}),
      clauses:[
        {id:'a',event:'issue.updated'},
        {id:'b',event:'issue.reviewed'},
      ],pattern:{root:{kind:'allOf',children:[
        {kind:'event',ref:'a'},{kind:'event',ref:'b'},
      ]}},
    }],
    getTriggerState:()=>({status:state,fireCount:0}),
    listTriggerMatches:()=>withMatch?[match]:[],
    listTriggerMatchHistory:()=>withMatch?[match]:[],
    listTemporalDeadlines:()=>pendingDeadline?[{
      deadlineId:'deadline-1',conditionId:'absence',
      matchId:'match-1',dueAt:'2026-10-16T10:30:00.000Z',
      status:'pending',
    }]:[],
    latestWake:()=>wakeStatus?{
      wakeId:'wake-1',status:wakeStatus,
      runtimeReceiptId:null,target:{runtime:'test',kind:'task',id:'x'},
      createdAt:now,
    }:null,
  };
  return store;
}

test('diagnostic state reasons are versioned, bounded and do not claim upstream certainty',async()=>{
  const cases=[
    [{withMatch:false},'no_local_match'],
    [{matchStatus:'partial'},'pattern_pending'],
    [{matchStatus:'partial',pendingDeadline:true},'temporal_pending'],
    [{matchStatus:'matched'},'effect_pending'],
    [{matchStatus:'matched',conditionOnly:true},'condition_satisfied'],
    [{matchStatus:'fired'},'fired'],
    [{matchStatus:'emitted'},'derived_emitted'],
    [{matchStatus:'expired'},'match_expired'],
    [{matchStatus:'matched',wakeStatus:'dead_letter'},'wake_failed'],
    [{state:'paused',matchStatus:'matched'},'inactive'],
    [{state:'deleted',matchStatus:'matched'},'inactive'],
    [{state:'expired',matchStatus:'matched'},'lifecycle_ended'],
    [{state:'completed',matchStatus:'matched'},'lifecycle_ended'],
  ];
  for(const [opts,expected] of cases){
    const view=await new TriggerInspector({
      store:fixture(opts),matchHistoryLimit:1,
    }).inspect({triggerId:'observe',version:'1'});
    assert.equal(view.diagnosis.contract,'ei.trigger-inspection.v1');
    assert.equal(view.diagnosis.kind,expected);
    assert.equal(view.diagnosis.sourceCertainty,'unverified',
      'stored match evidence cannot prove upstream completeness');
    assert.equal(view.diagnosis.evidence,'persisted_state');
    assert.ok(view.diagnosis.missingClauseIds.length<=2);
    assert.deepEqual(view.diagnosis.missingClauseIds,opts.withMatch===false
      ?['a','b']:['b']);
    assert.equal(view.diagnosis.pendingDeadlineCount,
      opts.pendingDeadline?1:0);
    assert.ok(!JSON.stringify(view).includes(rawSecret));
    assert.ok(view.why.code,
      'existing why-code remains available, not replaced by v1 diagnosis');
  }
});

test('restart-style independent inspector projections are deterministic',async()=>{
  const input={matchStatus:'partial',pendingDeadline:true};
  const first=await new TriggerInspector({store:fixture(input)})
    .inspect({triggerId:'observe'});
  const second=await new TriggerInspector({store:fixture(input)})
    .inspect({triggerId:'observe'});
  assert.deepEqual(first.diagnosis,second.diagnosis);
  assert.deepEqual(first.diagnosis,{
    contract:'ei.trigger-inspection.v1',
    kind:'temporal_pending',
    evidence:'persisted_state',
    sourceCertainty:'unverified',
    missingClauseIds:['b'],
    pendingDeadlineCount:1,
  });
  assert.equal(first.nextEvaluationAt,'2026-10-16T10:30:00.000Z');
});
