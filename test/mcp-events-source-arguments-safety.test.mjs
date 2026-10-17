import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { safeMcpSourceArguments } from '../scripts/lib/mcp-safe-arguments.mjs';
import { incompleteNegativeRefs } from '../dist/src/composite/deliveryGap.js';

test('MCP source argument snapshots reject SharedArrayBuffer views and non-JSON identities',()=>{
  const shared=new SharedArrayBuffer(16);
  const view=new Uint8Array(shared);
  view[0]=7;
  assert.throws(()=>safeMcpSourceArguments({nested:{view}}),/safe JSON/);
  assert.throws(()=>safeMcpSourceArguments({buffer:shared}),/safe JSON/);
  assert.throws(()=>safeMcpSourceArguments({nested:[new DataView(shared)]}),/safe JSON/);
  assert.throws(()=>safeMcpSourceArguments({nested:[new Uint8Array(2)]}),/safe JSON/);
  assert.throws(()=>safeMcpSourceArguments({nested:{date:new Date()}}),/safe JSON/);
  assert.throws(()=>safeMcpSourceArguments({nested:{n:1n}}),/safe JSON/);
  const cycle={};cycle.self=cycle;
  assert.throws(()=>safeMcpSourceArguments(cycle),/shared objects or cycles/);
  let executed=0;
  const getter={};
  Object.defineProperty(getter,'evil',{enumerable:true,get(){executed++;return 1;}});
  assert.throws(()=>safeMcpSourceArguments({getter}),/safe JSON/);
  const proxy=new Proxy({}, {ownKeys(){executed++;return [];}});
  assert.throws(()=>safeMcpSourceArguments({proxy}),/safe JSON/);
  assert.equal(executed,0,'no untrusted getter/proxy traps execute');
  const original={tenant:'safe',nested:{ids:[1,2,null,true]}};
  const isolated=safeMcpSourceArguments(original);
  original.nested.ids[0]=999;
  assert.deepEqual(isolated,{tenant:'safe',nested:{ids:[1,2,null,true]}});
});

test('JSONL rejects shared-memory source arguments without bypassing gap revision',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-mcp-shared-args-'));
  let store;
  try{
    store=new PersistentEventStore(dir);
    await store.init();
    const identity={tenant:'safe',nested:{ids:[1,2]}};
    const source={connectionId:'source',serverId:'upstream',eventName:'job.failed',
      arguments:identity,deliveryMode:'poll',truncated:true};
    const saved=await store.putMcpClientState(source);
    const before=store.getMcpGapStateAndSnapshot().snapshot;
    const shared=new SharedArrayBuffer(8);
    const view=new Uint8Array(shared);
    view[0]=5;
    const poison={tenant:'safe',nested:{view}};
    await assert.rejects(store.putMcpClientState({...source,arguments:poison,
      truncated:false,gapReconciled:true,
      expectedCompletenessRevision:saved.completenessRevision,
      reconciliationEvidenceId:'forged'}),/safe JSON/);
    assert.throws(()=>store.getMcpClientState('source','job.failed',poison),
      /safe JSON/,'unsafe identity cannot masquerade as saved key');
    view[0]=23;
    assert.equal(store.getMcpGapStateAndSnapshot().snapshot,before);
    const actual=store.getMcpClientState('source','job.failed',identity);
    assert.equal(actual.gapUnresolved,true);
    assert.equal(actual.completenessRevision,saved.completenessRevision);
    assert.deepEqual(actual.arguments,identity);
    assert.equal(store.listMcpClientStates().length,1);

    // A safe identity is deeply copied: caller changes to nested objects
    // cannot mutate the materialized index without a serialized revision.
    identity.nested.ids[0]=42;
    assert.deepEqual(store.getMcpClientState('source','job.failed',{
      tenant:'safe',nested:{ids:[1,2]},
    }).arguments,{tenant:'safe',nested:{ids:[1,2]}});
    assert.equal(store.getMcpGapStateAndSnapshot().snapshot,before);
    await store.close();
    store=new PersistentEventStore(dir);
    await store.init();
    assert.equal(store.getMcpGapStateAndSnapshot().snapshot,before);
    assert.equal(store.getMcpClientState('source','job.failed',{
      tenant:'safe',nested:{ids:[1,2]},
    }).gapUnresolved,true);
  }finally{
    await store?.close();
    await rm(dir,{recursive:true,force:true});
  }
});


test('JSONL trigger definition arguments cannot be mutated to hide an unresolved forbidden-source gap',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-gap-trigger-identity-'));
  let store;
  try {
    store=new PersistentEventStore(dir);
    await store.init();
    const id={tenant:'acme',nested:{region:'eu'}};
    const definition={
      triggerId:'safe-negative-trigger',version:'1',conditionOnly:true,
      clauses:[
        {id:'a',event:'job.started',serverId:'upstream',arguments:{},where:[]},
        {id:'b',event:'job.failed',serverId:'upstream',arguments:id,where:[]},
      ],
      pattern:{
        version:'2',root:{
          kind:'notFollowedBy',id:'protect-negative',
          child:{kind:'event',ref:'a'},
          forbidden:{kind:'event',ref:'b'},withinMs:1000,
        },
        partitionBy:[],
        selection:{overlap:'allow',afterMatch:'keepAll',maxMatchesPerEvent:10},
        execution:{maxCandidates:16,maxSemanticEvaluations:0,maxBufferedEvents:32},
      },
      withinMs:60000,
    };
    const returned=await store.putTrigger(definition);
    await store.putMcpClientState({
      connectionId:'source',serverId:'upstream',
      eventName:'job.failed',arguments:{tenant:'acme',nested:{region:'eu'}},
      deliveryMode:'poll',truncated:true,
    });
    const before=store.getMcpGapStateAndSnapshot().snapshot;
    const listed=store.listTriggers()[0];
    for (const copy of [definition,returned,listed]) {
      copy.clauses[1].arguments.tenant='forged';
      copy.clauses[1].arguments.nested.region='forged';
      copy.clauses[1].event='unrelated.event';
    }
    const stored=store.listTriggers()[0];
    assert.equal(stored.clauses[1].event,'job.failed');
    assert.deepEqual(stored.clauses[1].arguments,{
      tenant:'acme',nested:{region:'eu'},
    });
    assert.ok(incompleteNegativeRefs(stored,
      store.getMcpGapStateAndSnapshot().states,['source']).has('b'),
    'a host-mutated definition must not mark a missing forbidden event complete');
    assert.equal(store.getMcpGapStateAndSnapshot().snapshot,before);

    await assert.rejects(store.putTrigger({
      ...definition, triggerId:'unsafe-negative-trigger',
      clauses:[
        definition.clauses[0],
        {id:'b',event:'job.failed',serverId:'upstream',
         arguments:{nested:{view:new Uint8Array(new SharedArrayBuffer(8))}},
         where:[]},
      ],
    }),/safe JSON/);
    assert.equal(store.listTriggers().length,1);

    await store.close();
    store=new PersistentEventStore(dir);
    await store.init();
    assert.ok(incompleteNegativeRefs(store.listTriggers()[0],
      store.getMcpGapStateAndSnapshot().states,['source']).has('b'));
    assert.equal(store.getMcpGapStateAndSnapshot().snapshot,before);
  }finally{
    await store?.close();
    await rm(dir,{recursive:true,force:true});
  }
});
