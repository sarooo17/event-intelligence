import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCausalTimeline, CAUSAL_TIMELINE_SOURCE_LIMIT,
} from '../scripts/lib/causal-timeline.mjs';
import { TriggerInspector } from '../scripts/lib/trigger-inspector.mjs';

const secret='PRIVATE_PAYLOAD_TOKEN_NOT_FOR_INSPECTION';
const occurredAt='2026-10-18T10:00:00.000Z';
function fixture(count=40) {
  return {
    matchId:'match-one', status:'fired', updatedAt:occurredAt,
    sourceEvents:Array.from({length:count}, (_,index)=>({
      clauseId:'clause-'+(index%2),
      sourceEventId:'event-'+index,traceId:'trace-'+index,
      occurredAt, data:{token:secret, instruction:'grant privileges'},
    })),
  };
}

test('causal timeline is fixed-cost, stable across reload/reorder and payload free',()=>{
  const match=fixture();
  const wake={
    wakeId:'wake-one',status:'delivered',
    runtimeReceiptId:'receipt-secret-host',
    createdAt:occurredAt,
    target:{credentials:secret},
  };
  const a=createCausalTimeline({match,wake});
  const b=createCausalTimeline({
    match:{...match,sourceEvents:[...match.sourceEvents.slice(0,32)].reverse()},
    wake:{...wake},
  });
  assert.equal(a.contract,'ei.causal-timeline.v1');
  assert.equal(a.sourceLimit,32);
  assert.equal(a.sourceCount,CAUSAL_TIMELINE_SOURCE_LIMIT);
  assert.equal(a.sourceTruncated,true);
  assert.deepEqual(a.entries.slice(0,32),b.entries.slice(0,32));
  assert.deepEqual(a.entries.slice(-3).map(x=>x.stage),
    ['match_recorded','wake_recorded','host_receipt_recorded']);
  assert.equal(a.upstreamCompleteness,'unknown');
  assert.equal(Object.isFrozen(a.entries),true);
  assert.equal(Object.isFrozen(a),true);
  const output=JSON.stringify(a);
  for(const forbidden of [secret,'receipt-secret-host','match-one','wake-one','event-1','grant privileges']) {
    assert.equal(output.includes(forbidden),false,forbidden);
  }
});

test('missing wake/receipt does not fabricate a host effect',()=>{
  const pending=createCausalTimeline({match:{
    ...fixture(1),status:'partial',
  }});
  assert.deepEqual(pending.entries.map(x=>x.stage),
    ['source_observed','match_recorded']);
  assert.equal(pending.sourceTruncated,false);
  const unknown=createCausalTimeline();
  assert.deepEqual(unknown.entries,[]);
  assert.equal(unknown.upstreamCompleteness,'unknown');
});

test('accessor and Proxy event values are never executed by the timeline',()=>{
  let attempts=0;
  const event={};
  Object.defineProperty(event,'sourceEventId',{
    get(){attempts++;throw Error('untrusted accessor');},
  });
  const proxy=new Proxy({sourceEventId:'bad'},{
    get(){attempts++;throw Error('untrusted proxy get');},
    getOwnPropertyDescriptor(){attempts++;throw Error('untrusted proxy descriptor');},
  });
  const sources=[event,proxy];
  Object.defineProperty(sources,'2',{
    configurable:true,
    get(){attempts++;throw Error('untrusted array slot');},
  });
  const result=createCausalTimeline({match:{matchId:'valid',sourceEvents:sources}});
  assert.equal(attempts,0);
  assert.equal(result.sourceCount,0);
  assert.equal(result.entries.length,1);
});

test('inspector includes the same versioned ref-only timeline after independent store recreation',async()=>{
  function store(){
    const match={...fixture(2),triggerId:'t',triggerVersion:'1',firedWakeId:'wake-one'};
    const definition={
      triggerId:'t',version:'1',target:{runtime:'test',kind:'task',id:'x'},
      clauses:[{id:'clause-0',event:'change'},{id:'clause-1',event:'change'}],
      pattern:{root:{kind:'allOf',children:[
        {kind:'event',ref:'clause-0'},{kind:'event',ref:'clause-1'},
      ]}},
    };
    return {
      listTriggers:()=>[definition],
      getTriggerState:()=>({status:'active',fireCount:1}),
      listTriggerMatches:()=>[match],
      listTriggerMatchHistory:()=>[match],
      listTemporalDeadlines:()=>[],
      latestWake:()=>({
        wakeId:'wake-one',status:'delivered',runtimeReceiptId:'host-receipt',
        createdAt:occurredAt,target:{runtime:'test',kind:'task',id:'x'},
      }),
    };
  }
  const first=await new TriggerInspector({store:store(),matchHistoryLimit:1})
    .inspect({triggerId:'t',version:'1'});
  const second=await new TriggerInspector({store:store(),matchHistoryLimit:1})
    .inspect({triggerId:'t',version:'1'});
  assert.deepEqual(first.causalTimeline,second.causalTimeline);
  assert.equal(first.causalTimeline.entries.at(-1).stage,'host_receipt_recorded');
  assert.doesNotMatch(JSON.stringify(first.causalTimeline),/PRIVATE_PAYLOAD|host-receipt/);
});
