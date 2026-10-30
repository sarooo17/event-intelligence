import assert from 'node:assert/strict';
import test from 'node:test';
import {TriggerInspector} from '../scripts/lib/trigger-inspector.mjs';
import {persistedGapInspectionFact} from '../scripts/lib/inspection-persisted-mcp-gap.mjs';
const at='2026-10-29T10:00:00.000Z';
const match={matchId:'m',triggerId:'t',triggerVersion:'1',status:'partial',
  openedAt:at,updatedAt:at,expiresAt:'2026-10-29T12:00:00.000Z',
  sourceEvents:[],firedWakeId:null,derivedEventIds:[],patternState:null,partitionKey:null};
const definition={triggerId:'t',version:'1',
  clauses:[{id:'a',event:'a'}],pattern:{root:{kind:'event',ref:'a'}}};
function store({deadlines=[],derived=[]}={}){
  return {
    listTriggers:()=>{throw Error('unbounded definition scan forbidden')},
    getTrigger:()=>definition,
    getTriggerState:()=>({status:'active',fireCount:0}),
    listTriggerMatches:()=>{throw Error('unbounded match selection forbidden')},
    getBoundedInspectionMatch:async()=>match,
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
    listTriggerMatchHistory:()=>{throw Error('unbounded history scan forbidden')},
    getRecentTriggerMatchHistory:async(id,{limit})=>{
      assert.equal(id,'m');assert(limit>0);
      return {records:[match],hasMore:false};
    },
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
      evidenceRefLimit:2,matchHistoryLimit:2,
    }).inspect({triggerId:'t',version:'1'}),error=>
      error?.code==='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED');
  }
});
test('bounded mode refuses custom stores without bounded semantics',async()=>{
  const bad=store();
  delete bad.getBoundedInspectionDeadlines;
  await assert.rejects(()=>new TriggerInspector({
    store:bad,inspectionWindowLimit:2,
    evidenceRefLimit:2,matchHistoryLimit:2,
  }).inspect({triggerId:'t',version:'1'}),error=>
    error?.code==='EVENT_INTELLIGENCE_INSPECTION_STORE_UNSUPPORTED');
  for(const invalid of [0,-1,101,1.1,NaN,'10']){
    assert.throws(()=>new TriggerInspector({store:bad,inspectionWindowLimit:invalid,
      evidenceRefLimit:2,matchHistoryLimit:2}),
      /inspectionWindowLimit/);
  }
});

test('strict inspection always requires evidence/history limits and bounded match API',async()=>{
  const current=store();
  assert.throws(()=>new TriggerInspector({store:current,inspectionWindowLimit:2}),
    /requires evidenceRefLimit and matchHistoryLimit/);
  delete current.getBoundedInspectionMatch;
  await assert.rejects(()=>new TriggerInspector({store:current,
    inspectionWindowLimit:2,evidenceRefLimit:2,matchHistoryLimit:2,
  }).inspect({triggerId:'t',version:'1'}),e=>
    e?.code==='EVENT_INTELLIGENCE_INSPECTION_STORE_UNSUPPORTED');
});

test('strict mode rejects a poisoned cross-trigger/explicit-match result before evidence lookup',async()=>{
  for(const rogue of [
    {...match,triggerId:'foreign'},
    {...match,triggerVersion:'other'},
    {...match,matchId:'foreign-match'},
  ]) {
    const source=store();
    source.getBoundedInspectionMatch=async()=>rogue;
    source.getBoundedInspectionDeadlines=()=>{throw Error('evidence leaked');};
    await assert.rejects(()=>new TriggerInspector({
      store:source,inspectionWindowLimit:2,
      evidenceRefLimit:2,matchHistoryLimit:2,
    }).inspect({triggerId:'t',version:'1',matchId:'m'}),
    e=>e?.code==='EVENT_INTELLIGENCE_INSPECTION_MATCH_IDENTITY_INVALID');
  }
});
test('strict mode refuses stores missing keyed definition or bounded history capability',async()=>{
  for(const key of ['getTrigger','getRecentTriggerMatchHistory']){
    const source=store();
    delete source[key];
    await assert.rejects(()=>new TriggerInspector({
      store:source,inspectionWindowLimit:2,evidenceRefLimit:2,matchHistoryLimit:2,
    }).inspect({triggerId:'t',version:'1'}),
    e=>e?.code==='EVENT_INTELLIGENCE_INSPECTION_STORE_UNSUPPORTED');
  }
});

test('strict inspection never executes an unbounded optional persisted source fact reader',async()=>{
  const source=store({deadlines:[deadline(1)]});
  let factCalls=0;
  source.getInspectionFact=async()=>{
    factCalls++;
    throw Error('unbounded source inventory may not be read in strict mode');
  };
  source.listEventSources=()=>{throw Error('unbounded source list forbidden')};
  const view=await new TriggerInspector({
    store:source,inspectionWindowLimit:2,evidenceRefLimit:2,matchHistoryLimit:2,
  }).inspect({triggerId:'t',version:'1',matchId:'m'});
  assert.equal(factCalls,0);
  assert.equal(view.diagnosisV2.kind,'deadline_pending');
  assert.equal(view.diagnosisV2.upstreamCompleteness,'unknown');
});

test('null or invalid bounded source page never executes unbounded inventory fallback',async()=>{
  for(const returned of [null,undefined,{}, {records:[],hasMore:true},
    {records:'bad',hasMore:false}, {records:[{}, {}, {}],hasMore:false}]){
    let fullScans=0;
    const mock={
      getTrigger:async()=>({triggerId:'t',version:'1',
        clauses:[{id:'a',serverId:'server',event:'event.changed',arguments:{}}]}),
      getTriggerState:async()=>({connectionIds:['connection']}),
      listBoundedEventSources:async()=>returned,
      listEventSources:async()=>{fullScans++;throw Error('unbounded read');},
      getMcpClientState:async()=>{throw Error('should not read source without proof');},
    };
    const fact=await persistedGapInspectionFact(mock,{
      triggerId:'t',triggerVersion:'1',matchId:null,
    },{boundedSourceLimit:2});
    assert.equal(fact,null,'invalid or incomplete bounded page returns unknown');
    assert.equal(fullScans,0,'strict adapter must never load all sources');
  }
});
