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

test('strict mode rejects oversized history from a custom bounded store',async()=>{
  const source=store();
  source.getRecentTriggerMatchHistory=async(id,options)=>{
    assert.equal(id,'m');
    assert.equal(options.maxRowBytes,65536);
    assert.equal(options.maxTotalBytes,1048576);
    assert.equal(options.maxScanMs,2000);
    return {records:[{...match,sourceEvents:[{
      clauseId:'a',sourceEventId:'large',data:{secret:'S'.repeat(70000)},
    }]}],hasMore:false};
  };
  await assert.rejects(()=>new TriggerInspector({
    store:source,inspectionWindowLimit:2,evidenceRefLimit:2,matchHistoryLimit:2,
  }).inspect({triggerId:'t',version:'1'}),e=>
    e?.code==='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED');
});

test('strict inspection refuses cumulative history even when every row is individually bounded',async()=>{
  const source=store();
  const revision={...match,opaque:'X'.repeat(59500)};
  assert(Buffer.byteLength(JSON.stringify(revision),'utf8')<65536);
  source.getRecentTriggerMatchHistory=async(id,options)=>{
    assert.equal(id,'m');
    assert.equal(options.maxTotalBytes,1048576);
    return {records:Array.from({length:19},()=>({...revision})),hasMore:false};
  };
  await assert.rejects(()=>new TriggerInspector({
    store:source,inspectionWindowLimit:20,evidenceRefLimit:2,matchHistoryLimit:20,
  }).inspect({triggerId:'t',version:'1'}),e=>
    e?.code==='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED');
});

test('strict inspection refuses oversized returned custom-store deadline/derived pages',async()=>{
  for(const key of ['getBoundedInspectionDeadlines','getBoundedInspectionDerivedEvents']){
    const source=store();
    let page;
    if(key==='getBoundedInspectionDeadlines'){
      page={records:[{...deadline(1),untrusted:'X'.repeat(20000)}],hasMore:false};
    }else{
      page={records:[{...derived(1),directParents:['X'.repeat(20000)]}],hasMore:false};
    }
    source[key]=async()=>page;
    await assert.rejects(()=>new TriggerInspector({
      store:source,inspectionWindowLimit:2,evidenceRefLimit:2,matchHistoryLimit:2,
    }).inspect({triggerId:'t',version:'1'}),e=>
      e?.code==='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED');
  }
});

test('strict inspection refuses an oversized assembled response from a custom store',async()=>{
  const source=store();
  source.getTriggerState=()=>({status:'active',fireCount:0,
    unexpectedHostValue:'X'.repeat(3200000)});
  await assert.rejects(()=>new TriggerInspector({
    store:source,inspectionWindowLimit:2,evidenceRefLimit:2,matchHistoryLimit:2,
  }).inspect({triggerId:'t',version:'1'}),e=>
    e?.code==='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED');
});

test('strict output rejects active JSON hooks without invoking them',async()=>{
  for(const flavor of ['toJSON','getter','proxy']){
    let invoked=0;
    const source=store();
    if(flavor==='toJSON'){
      source.getTriggerState=()=>({status:'active',fireCount:0,
        toJSON(){invoked++;return invoked===1?{status:'active'}:
          {status:'active',huge:'X'.repeat(3200000)};}});
    }else if(flavor==='getter'){
      source.getBoundedInspectionDerivedEvents=async()=>({records:[{
        ...derived(1),event:{sourceEventId:'e',name:'derived',
          occurredAt:at,data:Object.defineProperty({},'secret',{
            enumerable:true,get(){invoked++;return 'hidden';},
          })},
      }],hasMore:false});
    }else{
      source.getBoundedInspectionDerivedEvents=async()=>({records:[{
        ...derived(1),directParents:new Proxy([],{get(target,key){
          invoked++;return Reflect.get(target,key);
        }}),
      }],hasMore:false});
    }
    await assert.rejects(()=>new TriggerInspector({
      store:source,inspectionWindowLimit:2,evidenceRefLimit:2,
      matchHistoryLimit:2,
    }).inspect({triggerId:'t',version:'1'}),e=>
      e?.code==='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED');
    assert.equal(invoked,0,'strict byte measurement cannot execute '+flavor);
  }
});

test('strict response is a detached inert JSON snapshot',async()=>{
  const source=store();
  const state={status:'active',fireCount:0};
  source.getTriggerState=()=>state;
  const result=await new TriggerInspector({
    store:source,inspectionWindowLimit:2,evidenceRefLimit:2,matchHistoryLimit:2,
  }).inspect({triggerId:'t',version:'1'});
  state.extra='mutated after inspection';
  assert.equal(result.lifecycle.extra,undefined);
  assert.equal(typeof result.toJSON,'undefined');
  assert.doesNotThrow(()=>JSON.stringify(result));
});
