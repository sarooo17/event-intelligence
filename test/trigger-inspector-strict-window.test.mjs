import assert from 'node:assert/strict';
import test from 'node:test';
import {TriggerInspector} from '../scripts/lib/trigger-inspector.mjs';
const at='2026-10-29T10:00:00.000Z';
const match={matchId:'m',triggerId:'t',triggerVersion:'1',status:'partial',
  openedAt:at,updatedAt:at,expiresAt:'2026-10-29T12:00:00.000Z',
  sourceEvents:[],firedWakeId:null,derivedEventIds:[],patternState:null,partitionKey:null};
const definition={triggerId:'t',version:'1',
  clauses:[{id:'a',event:'a'}],pattern:{root:{kind:'event',ref:'a'}}};
function store({deadlines=[],derived=[]}={}){
  return {
    listTriggers:()=>[definition],getTriggerState:()=>({status:'active',fireCount:0}),
    listTriggerMatches:()=>[match],
    getBoundedInspectionDeadlines:async(matchId,{limit})=>{
      assert.equal(matchId,'m');
      return {records:deadlines.slice(0,limit),hasMore:deadlines.length>limit};
    },
    getBoundedInspectionDerivedEvents:async(matchId,{limit})=>{
      assert.equal(matchId,'m');
      return {records:derived.slice(0,limit),hasMore:derived.length>limit};
    },
    listTemporalDeadlines:()=>{throw Error('full deadline scan forbidden')},
    listDerivedEvents:()=>{throw Error('full derived scan forbidden')},
    listTriggerMatchHistory:()=>[match],
  };
}
const deadline=(i)=>({deadlineId:'d'+i,matchId:'m',conditionId:'a',
  status:'pending',dueAt:'2026-10-29T10:20:00.000Z'});
const derived=(i)=>({matchId:'m',
  event:{sourceEventId:'e'+i,name:'derivative',occurredAt:at,data:{}},
  directParents:[],rootEvidence:[]});
test('bounded inspect neither scans full scoped deadline/derived history nor lies about counts',async()=>{
  const inspector=new TriggerInspector({
    store:store({deadlines:[deadline(1)],derived:[derived(1)]}),
    inspectionWindowLimit:2,evidenceRefLimit:2,matchHistoryLimit:2,
  });
  const view=await inspector.inspect({triggerId:'t',version:'1'});
  assert.equal(view.evidenceSummary.inspectionWindowLimit,2);
  assert.equal(view.evidenceSummary.pendingDeadlineCount,1);
  assert.equal(view.lineage.derivedOutputs.length,1);
  assert.equal(view.diagnosisV2.kind,'deadline_pending');
});
test('window truncation is a failure, not a false pending/missing claim',async()=>{
  for(const field of ['deadlines','derived']){
    const two=[field==='deadlines'?deadline(1):derived(1),
      field==='deadlines'?deadline(2):derived(2),
      field==='deadlines'?deadline(3):derived(3)];
    await assert.rejects(()=>new TriggerInspector({
      store:store({[field]:two}),inspectionWindowLimit:2,
    }).inspect({triggerId:'t',version:'1'}),error=>
      error?.code==='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED');
  }
});
test('bounded mode refuses custom stores without bounded semantics',async()=>{
  const bad=store();
  delete bad.getBoundedInspectionDeadlines;
  await assert.rejects(()=>new TriggerInspector({
    store:bad,inspectionWindowLimit:2,
  }).inspect({triggerId:'t',version:'1'}),error=>
    error?.code==='EVENT_INTELLIGENCE_INSPECTION_STORE_UNSUPPORTED');
  for(const invalid of [0,-1,101,1.1,NaN,'10']){
    assert.throws(()=>new TriggerInspector({store:bad,inspectionWindowLimit:invalid}),
      /inspectionWindowLimit/);
  }
});
