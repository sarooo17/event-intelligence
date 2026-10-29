import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CompositeTriggerEngine} from '../dist/src/composite/engine.js';
import {PersistentEventStore} from '../scripts/lib/persistent-event-store.mjs';

function trigger(id, semantic=false){
  const clause={id:'issue',event:'github.issue.updated',serverId:'github',
    arguments:{},where:[{path:'repository',op:'eq',value:'example/repo'}]};
  const child={kind:'event',ref:'issue'};
  return {
    triggerId:id,version:'1',clauses:[clause],
    pattern:{version:'2',
      root:semantic?{
        kind:'semantic',id:'important',
        refs:['issue'],instruction:'Is the issue change important?',
        input:['issue.title'],matchThreshold:0.8,rejectThreshold:0.2,
        uncertain:'reject',
        execution:{cache:true,timeoutMs:1000,onUnavailable:'reject'},
        child,
      }:child,
      execution:{maxCandidates:8,maxSemanticEvaluations:2,maxBufferedEvents:8},
    },
    withinMs:60000,target:{runtime:'independent-host',kind:'task',id:'notify'},
  };
}
function event(id,repo='example/repo'){
  return {traceId:'trace-'+id,sourceEventId:id,
    name:'github.issue.updated',serverId:'github',
    occurredAt:'2026-10-29T11:00:00.000Z',
    data:{repository:repo,title:'Critical regression fixed'}};
}
test('independent runtime runs structural patterns without an evaluator, does not automatically deliver',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-49-independent-no-model-'));
  const store=new PersistentEventStore(dir);
  try{
    await store.init();
    const engine=new CompositeTriggerEngine(store,null,()=>new Date('2026-10-29T11:00:10Z'));
    await engine.register(trigger('structural'));
    await engine.register(trigger('semantic',true));
    const ignored=await engine.ingest(event('unrelated','else/repo'));
    assert.deepEqual(ignored,[],'source-schema prefilter must avoid all evaluation');
    const result=await engine.ingest(event('one'));
    assert(result.some(x=>x.triggerId==='structural'&&x.matched===true));
    assert(!result.some(x=>x.triggerId==='semantic'&&x.matched===true),
      'missing optional evaluator must never invent importance');
    assert.equal(store.auditLength()>0,true,'deterministic audit still functions');
    assert.deepEqual((await store.listWakes?.())??[],[],
      'only a host-owned wake/delivery adapter may perform a downstream action');
    await store.close();
  }finally{
    await store.close();
    await rm(dir,{recursive:true,force:true});
  }
});
test('host-selected evaluator is called only for source-eligible event and stays vendor-neutral',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-49-host-model-'));
  const store=new PersistentEventStore(dir);
  const inputs=[];
  try{
    await store.init();
    const providerNeutral={
      cacheIdentity:'independent/model-contract-v1',
      async evaluate(request){
        inputs.push(request);
        return {evaluator:'independent/model-contract-v1',probability:0.95};
      },
    };
    const engine=new CompositeTriggerEngine(store,providerNeutral,
      ()=>new Date('2026-10-29T11:00:10Z'),
      {semanticContextRevision:'criteria-v2',semanticCacheTtlMs:60000});
    await engine.register(trigger('semantic',true));
    const ignored=await engine.ingest(event('ignored','foreign/repo'));
    assert.deepEqual(ignored,[]);
    assert.equal(inputs.length,0);
    const result=await engine.ingest(event('real'));
    assert(result.some(x=>x.matched===true));
    assert.equal(inputs.length,1);
    assert.equal(inputs[0].instruction,'Is the issue change important?');
    assert.deepEqual(inputs[0].input,{'issue.title':'Critical regression fixed'});
    // Matching is not a host write/delivery; EI did not invoke any host action.
    assert.deepEqual((await store.listWakes?.())??[],[]);
  }finally{
    await store.close();
    await rm(dir,{recursive:true,force:true});
  }
});
