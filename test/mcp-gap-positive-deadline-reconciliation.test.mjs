import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';

test('gap retries retain only currently selected positive debounce deadlines',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-gap-positive-deadlines-'));
  let store;
  try{
    store=new PersistentEventStore(dir);
    await store.init();
    const t0=Date.now()+3600000;
    let now=new Date(t0);
    const engine=new CompositeTriggerEngine(store,null,()=>now);
    const triggerId='gap-positive-reconcile';
    await engine.register({
      triggerId,version:'1',conditionOnly:true,
      clauses:[
        {id:'a',event:'job.started',serverId:'upstream',arguments:{},where:[]},
        {id:'b',event:'job.failed',serverId:'upstream',arguments:{},where:[]},
      ],
      pattern:{
        version:'2',root:{kind:'anyOf',children:[
          {kind:'debounce',id:'positive-debounce',ref:'a',forMs:5000,child:{kind:'event',ref:'a'}},
          {kind:'notFollowedBy',id:'quiet',child:{kind:'event',ref:'a'},
            forbidden:{kind:'event',ref:'b'},withinMs:1000},
        ]},partitionBy:[],
        selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:20},
        execution:{maxCandidates:64,maxSemanticEvaluations:0,maxBufferedEvents:64},
      },
      withinMs:60000,
    });
    await store.putMcpClientState({
      connectionId:'source',serverId:'upstream',eventName:'job.failed',
      arguments:{},truncated:true,deliveryMode:'poll',
    });
    const incoming=(suffix,ms)=>({
      traceId:'debounce:'+suffix,sourceEventId:'debounce:'+suffix,
      name:'job.started',serverId:'upstream',provider:'mcp',
      occurredAt:new Date(ms).toISOString(),subscriptionArguments:{},
      data:{},
    });
    await engine.ingest(incoming('one',t0));
    const first=store.listTemporalDeadlines({triggerId,status:'pending'});
    assert.ok(first.some(x=>x.dueAt===new Date(t0+5000).toISOString()));
    now=new Date(t0+200);
    await engine.ingest(incoming('two',t0+200));
    const second=store.listTemporalDeadlines({triggerId,status:'pending'});
    assert.ok(second.length>0);
    assert.equal(second.some(x=>x.dueAt===new Date(t0+5000).toISOString()),
      false,'superseded debounce deadline must be cancelled under a gap');
    assert.ok(second.some(x=>x.dueAt===new Date(t0+5200).toISOString()));
    assert.ok(second.some(x=>x.dueAt===new Date(t0+1000).toISOString()),
      'blocked negative retry deadline must remain pending');
    const total=store.listTemporalDeadlines({triggerId});
    assert.ok(total.some(x=>x.status==='cancelled' &&
      x.dueAt===new Date(t0+5000).toISOString()));
  }finally{
    await store?.close();
    await rm(dir,{recursive:true,force:true});
  }
});
