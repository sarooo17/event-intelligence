import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import {
  createHostMcpEventsConnection,McpEventsClientManager,
} from '../scripts/lib/mcp-events-client.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TriggerControlPlane } from '../scripts/lib/trigger-control-plane.mjs';

const t0=Date.UTC(2026,9,16,9,0,0);
async function fixture(poll,overrides={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-sep3415-poll-floor-'));
  const now={ms:t0};
  const calls=[];
  const client={
    getServerCapabilities:()=>({
      extensions:{'io.modelcontextprotocol/events':{listChanged:false}},
    }),
    async request(msg){
      if(msg.method==='events/list'){
        return {events:[{
          name:'change.detected',delivery:['poll'],
          inputSchema:{type:'object'},payloadSchema:{type:'object'},
        }]};
      }
      if(msg.method==='events/poll'){
        calls.push(msg.params);
        return poll(msg.params,calls.length);
      }
      throw new Error('Unexpected method');
    },
  };
  const store=new PersistentEventStore(dir);
  await store.init();
  const engine=new CompositeTriggerEngine(store,null,()=>new Date(now.ms));
  const consumer=new CompositeEventConsumer({
    store,triggerEngine:engine,wakeCoordinators:new Map(),
  });
  const control=new TriggerControlPlane({store,triggerEngine:engine});
  const conn=createHostMcpEventsConnection({
    connectionId:'source',serverId:'upstream',client,
    pollIntervalMs:5000,pollFloorMs:1000,maxPollBatches:2,
    ...overrides,
  });
  const manager=new McpEventsClientManager({
    store,compositeEventConsumer:consumer,connections:[conn],
    now:()=>new Date(now.ms),
    registerEventSource:(source)=>control.registerEventSource(source,{
      type:'system',principal_id:'ei:poll-fixture',
    }),
  });
  await manager.discoverAll();
  await control.createTrigger({
    definition:{
      triggerId:'poll-floor',version:'1',
      clauses:[{id:'src',event:'change.detected',
        serverId:'upstream',arguments:{},where:[]}],
      pattern:{root:{kind:'event',ref:'src'}},
      withinMs:60000,
      target:{runtime:'test',kind:'task',id:'not-delivered'},
    },
    connectionIds:['source'],
    actor:{type:'user',principal_id:'user1'},
    owner:{type:'user',principal_id:'user1'},
  });
  return {dir,store,manager,now,calls,connection:conn,
    state:()=>store.getMcpClientState('source','change.detected'),
    close:async()=>{await manager.close();await store.close();await rm(dir,{recursive:true,force:true});},
  };
}

test('omitted cursor is null and producer nextPollMs=0 cannot bypass default one-second floor',async()=>{
  const x=await fixture(()=>({events:[],nextPollMs:0,hasMore:false}));
  try{
    const first=await x.manager.pollConnection('source',{respectSchedule:true});
    assert.equal(first[0].status,'ok');
    assert.equal(first[0].cursor,null);
    assert.equal(first[0].nextPollMs,1000);
    assert.equal(x.state().cursor,null);
    assert.equal(x.state().nextPollAt,new Date(t0+1000).toISOString());
    assert.deepEqual(x.calls.map(v=>v.cursor),[null]);

    x.now.ms+=999;
    const early=await x.manager.pollConnection('source',{respectSchedule:true});
    assert.equal(early[0].status,'scheduled');
    assert.equal(x.calls.length,1,'no provider call before producer floor');
    x.now.ms+=1;
    const due=await x.manager.pollConnection('source',{respectSchedule:true});
    assert.equal(due[0].status,'ok');
    assert.equal(x.calls.length,2);
  } finally{await x.close();}
});

test('producer slower backoff wins, host can raise normal poll floor',async()=>{
  for(const [floor,producer,expected] of [
    [1000,7000,7000],[1500,0,1500],[2000,1000,2000],
  ]){
    const x=await fixture(()=>({
      events:[],cursor:'c1',nextPollMs:producer,hasMore:false,
    }),{pollFloorMs:floor});
    try{
      const r=await x.manager.pollConnection('source');
      assert.equal(r[0].nextPollMs,expected);
      assert.equal(x.state().nextPollAt,
        new Date(t0+expected).toISOString());
    } finally {await x.close();}
  }
  for(const invalid of [999,300001,-1,'1000']){
    assert.throws(()=>createHostMcpEventsConnection({
      connectionId:'x',serverId:'x',pollFloorMs:invalid,
      request:()=>{},getCapabilities:()=>({}),
    }),/pollFloorMs/);
  }
});

test('hasMore drains promptly but maxPollBatches bounds every sweep',async()=>{
  const x=await fixture((_p,n)=>({
    events:[],cursor:'page:'+n,hasMore:true,nextPollMs:0,
  }),{maxPollBatches:3});
  try{
    const first=await x.manager.pollConnection('source');
    assert.equal(first[0].batches,3);
    assert.equal(first[0].batchLimitReached,true);
    assert.equal(first[0].nextPollMs,0);
    assert.equal(x.state().cursor,'page:3');
    assert.equal(x.state().nextPollAt,new Date(t0).toISOString());
    assert.deepEqual(x.calls.map(p=>p.cursor),
      [null,'page:1','page:2']);
    // A subsequent explicit sweep can drain the next three pages.
    const second=await x.manager.pollConnection('source');
    assert.equal(second[0].batches,3);
    assert.equal(x.calls.length,6);
  }finally{await x.close();}
});

test('backlog without continuation cursor rejects before persistence',async()=>{
  const x=await fixture(()=>({
    events:[],hasMore:true,nextPollMs:0,
  }));
  try{
    await assert.rejects(x.manager.pollConnection('source'),
      /backlog requires a continuation cursor/);
    assert.equal(x.state(),null);
    assert.equal(x.calls.length,1);
  }finally{await x.close();}
});

test('persistent cursor resumes safely after restart and still respects poll floor',async()=>{
  const x=await fixture((params)=>({
    events:[],cursor:params.cursor ?? 'safe:1',hasMore:false,nextPollMs:0,
  }));
  try{
    await x.manager.pollConnection('source');
    assert.equal(x.state().cursor,'safe:1');
    assert.equal(x.state().nextPollAt,new Date(t0+1000).toISOString());
    const again=await x.manager.pollConnection('source',{respectSchedule:true});
    assert.equal(again[0].status,'scheduled');
    assert.equal(x.calls.length,1);
  }finally{await x.close();}
});
