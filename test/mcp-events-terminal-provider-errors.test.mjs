import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import {
  createHostMcpEventsConnection, McpEventsClientManager,
} from '../scripts/lib/mcp-events-client.mjs';
import {
  classifyTerminalMcpProviderError,
} from '../scripts/lib/mcp-provider-terminal-error.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TriggerInspector } from '../scripts/lib/trigger-inspector.mjs';
import { TriggerControlPlane } from '../scripts/lib/trigger-control-plane.mjs';

const secret='provider-bearer-DO-NOT-LOG';
const unavailable=(code,kind='event')=>({
  code,data:{kind},message:secret,cause:{authorization:secret},
});
function requestStub(fn){
  return {
    getServerCapabilities:()=>({
      extensions:{'io.modelcontextprotocol/events':{listChanged:false}},
    }),
    async request(req){
      if(req.method==='events/list'){
        return {events:['a.updated','b.updated'].map(name=>({
          name,description:'fixture',delivery:['poll'],
          inputSchema:{type:'object'},payloadSchema:{type:'object'},
        }))};
      }
      if(req.method==='events/poll') return fn(req.params);
      throw new Error('unexpected RPC method');
    },
  };
}
async function setup(onPoll,{now=()=>new Date(),authorityEpoch=null,onRevoke=null}={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-terminal-provider-'));
  const store=new PersistentEventStore(dir);
  await store.init();
  if(authorityEpoch) {
    store.requireMcpSessionFence=true;
    store.beginMcpConnectionAuthority=async()=>({active:true});
    store.revokeMcpConnectionAuthority=async input=>
      onRevoke ? onRevoke(input) : true;
  }
  const engine=new CompositeTriggerEngine(store);
  const consumer=new CompositeEventConsumer({
    store,triggerEngine:engine,wakeCoordinators:new Map(),
  });
  const control=new TriggerControlPlane({store,triggerEngine:engine});
  const conn=createHostMcpEventsConnection({
    connectionId:'conn',serverId:'server',client:requestStub(onPoll),
    pollIntervalMs:5000,maxPollBatches:2,authorityEpoch,
  });
  const manager=new McpEventsClientManager({
    store,compositeEventConsumer:consumer,connections:[conn],now,
    registerEventSource:source=>control.registerEventSource(source,{
      type:'system',principal_id:'terminal-provider-fixture',
    }),
  });
  if(authorityEpoch)await manager.prepareConnectionAuthorities();
  await manager.discoverAll();
  for(const [i,name] of ['a.updated','b.updated'].entries()){
    const user={type:'user',principal_id:'user1'};
    await control.createTrigger({
      definition:{
        triggerId:'test-'+i,version:'1',
        clauses:[{id:'e',event:name,serverId:'server',where:[]}],
        pattern:{root:{kind:'event',ref:'e'}},
        target:{runtime:'reference',kind:'task',id:String(i)},
        withinMs:60000,
      },
      connectionIds:['conn'],actor:user,owner:user,
    });
  }
  return {store,manager,dir,close:async()=>{
    await manager.close();await store.close();
    await rm(dir,{recursive:true,force:true});
  }};
}

test('terminal error decoder reads own data descriptors without invoking hostile traps',()=>{
  assert.deepEqual(classifyTerminalMcpProviderError(unavailable(-32023)),
    {reason:'not_found',scope:'subscription'});
  assert.deepEqual(classifyTerminalMcpProviderError(
    unavailable(-32024,'connection')),
    {reason:'forbidden',scope:'connection'});
  for(const err of [
    unavailable(-32025),unavailable(-32026),unavailable(-32027),
    unavailable(-32011),unavailable('-32023'),unavailable(-32023,'surprise'),
    {...unavailable(-32023),data:null},
    new Proxy(unavailable(-32023),{
      get(){throw new Error(secret)},
      getOwnPropertyDescriptor(){throw new Error(secret)},
    }),
    {get code(){throw new Error(secret)}},
    {code:-32023,data:{get kind(){throw new Error(secret)}}},
    {code:-32023,data:new Proxy({kind:'event'},{
      getOwnPropertyDescriptor(){throw new Error(secret)},
    })},
  ]) assert.equal(classifyTerminalMcpProviderError(err),null);
});

test('NotFound fences only the affected subscription; healthy sources continue',async()=>{
  const calls=[];
  const fixture=await setup(params=>{
    calls.push(params.name);
    if(params.name==='a.updated') throw unavailable(-32023);
    return {events:[],cursor:'b-cursor',hasMore:false,nextPollMs:2000};
  });
  try{
    const first=await fixture.manager.pollConnection('conn');
    assert.equal(first.length,2);
    const missing=first.find(x=>x.eventName==='a.updated');
    assert.equal(missing.status,'terminal');
    assert.equal(missing.reason,'not_found');
    assert.equal(first.find(x=>x.eventName==='b.updated').status,'ok');

    const second=await fixture.manager.pollConnection('conn');
    assert.equal(second.find(x=>x.eventName==='a.updated').status,'terminal');
    assert.equal(second.find(x=>x.eventName==='b.updated').status,'ok');
    assert.deepEqual(calls,['a.updated','b.updated','b.updated'],
      'terminal NotFound must not retry or disable an unrelated source');
    const unavailableState=fixture.store.getMcpClientState('conn','a.updated');
    assert.equal(unavailableState?.sourceAvailability,'not_found',
      'only the validated subscription NotFound marker is persisted');
    assert.equal(unavailableState?.cursor,null,'terminal failure must not checkpoint cursor');
    assert.equal(fixture.store.getMcpClientState('conn','b.updated').sourceAvailability,
      'available','healthy subscription must be independent');
    assert.equal((await new TriggerInspector({store:fixture.store})
      .inspect({triggerId:'test-0',version:'1'})).diagnosisV2.kind,
      'source_unavailable');
    assert.equal((await new TriggerInspector({store:fixture.store})
      .inspect({triggerId:'test-1',version:'1'})).diagnosisV2.kind,
      'not_yet_satisfied');
    const independentRead=new PersistentEventStore(fixture.dir);
    await independentRead.init();
    assert.equal((await new TriggerInspector({store:independentRead})
      .inspect({triggerId:'test-0',version:'1'})).diagnosisV2.kind,
      'source_unavailable','source observation survives store reopen');
    await independentRead.close();
    assert.ok(!JSON.stringify(fixture.store.listMcpClientStates()).includes(secret),
      'provider private error message must never be persisted');
    assert.equal(fixture.store.getMcpClientState(
      'conn','b.updated').cursor,'b-cursor');
    assert.ok(!JSON.stringify(first).includes(secret));
  }finally{await fixture.close();}
});

test('validated Forbidden quarantines this connection without further provider calls',async()=>{
  let calls=0;
  const fixture=await setup(params=>{
    calls++;
    throw unavailable(-32024,'connection');
  });
  try{
    const first=await fixture.manager.pollConnection('conn');
    assert.equal(first[0].status,'terminal');
    assert.equal(first[0].reason,'forbidden');
    assert.equal(first[1].status,'terminal');
    assert.equal(calls,1);
    const next=await fixture.manager.pollConnection('conn');
    assert.equal(next[0].status,'terminal');
    assert.equal(next[0].reason,'forbidden');
    assert.equal(calls,1);
    assert.ok(!JSON.stringify(next).includes(secret));
  }finally{await fixture.close();}
});

test('malformed or transient provider failures keep neutral diagnostics and do not quarantine',async()=>{
  let calls=0;
  const fixture=await setup(params=>{
    calls++;
    if(params.name==='a.updated') throw unavailable(-32025,'event');
    return {events:[],cursor:'safe',hasMore:false,nextPollMs:5000};
  });
  try{
    for(let attempt=0;attempt<2;attempt++){
      const result=await fixture.manager.pollAll();
      assert.equal(result[0].error,'MCP Events provider operation failed');
      assert.ok(!JSON.stringify(result).includes(secret));
    }
    assert.equal(calls,2,'transient errors remain eligible for bounded retry');
  }finally{await fixture.close();}
});

test('terminal error after a good backlog page reports committed effects',async()=>{
  let calls=0;
  const fx=await setup(params=>{
    if(params.name!=='a.updated') {
      return {events:[],cursor:'b',hasMore:false,nextPollMs:5000};
    }
    calls++;
    if(calls===2) throw unavailable(-32023);
    return {
      events:[{
        eventId:'a-event-1',name:'a.updated',
        timestamp:'2026-10-16T12:00:00.000Z',data:{},
      }],
      cursor:'a:1',hasMore:true,nextPollMs:0,
    };
  },{now:()=>new Date('2026-10-16T12:00:00.000Z')});
  try{
    const result=await fx.manager.pollConnection('conn');
    const stopped=result.find(x=>x.eventName==='a.updated');
    assert.equal(stopped.status,'terminal');
    assert.equal(stopped.reason,'not_found');
    assert.equal(stopped.accepted,1);
    assert.equal(stopped.batches,1);
    assert.equal(stopped.cursor,'a:1');
    assert.equal(fx.store.getMcpClientState('conn','a.updated').cursor,'a:1');
    const delay=await fx.manager.nextDelay(fx.manager.connections.get('conn'));
    // A fixed clock guarantees the remaining healthy source delay is
    // exactly 5000ms, independent of CI machine scheduling.
    assert.equal(delay,5000,
      'terminal source must be excluded from the next timer deadline');
    const again=await fx.manager.pollConnection('conn');
    assert.equal(again.find(x=>x.eventName==='a.updated').accepted,0);
    assert.equal(calls,2,'no retries after NotFound');
  }finally{await fx.close();}
});


test('Forbidden from provider revokes shared host epoch, not merely this process poll cache',async()=>{
  const epoch='host-owned-forbidden-epoch'.padEnd(48,'q');
  const revoked=[];
  let calls=0;
  const fixture=await setup(()=>{
    calls++;throw unavailable(-32024,'connection');
  },{authorityEpoch:epoch,onRevoke:async input=>{revoked.push(input);return true}});
  try {
    const first=await fixture.manager.pollConnection('conn');
    assert.equal(first[0].reason,'forbidden');
    assert.deepEqual(revoked,[{connectionId:'conn',epoch}]);
    assert.equal(fixture.manager.pendingAuthorityRevocations.size,0);
    const later=await fixture.manager.pollConnection('conn');
    assert.equal(later[0].reason,'forbidden');
    assert.equal(calls,1);
    assert.equal(revoked.length,1);
  }finally {await fixture.close()}
});

test('Failed forbidden epoch revocation is not falsely reported as success and retries on close',async()=>{
  const epoch='host-owned-outage-epoch'.padEnd(48,'q');
  let calls=0;
  const fixture=await setup(()=>{
    throw unavailable(-32024,'connection');
  },{authorityEpoch:epoch,onRevoke:async()=>{
    calls++;
    if(calls<=2)throw Error('private-db-connection-failure');
    return true;
  }});
  try {
    await assert.rejects(()=>fixture.manager.pollConnection('conn'),e=>
      e.code==='MCP_SESSION_REVOCATION_INCOMPLETE' &&
      !e.message.includes('private-db'));
    assert.equal(fixture.manager.pendingAuthorityRevocations.size,1);
    await assert.rejects(()=>fixture.manager.pollConnection('conn'),e=>
      e.code==='MCP_SESSION_REVOCATION_INCOMPLETE');
    assert.equal(calls,2,
      'a second poll must re-attempt PG revoke, not return fake terminal success');
    const confirmed=await fixture.manager.pollConnection('conn');
    assert.equal(confirmed[0].reason,'forbidden');
    assert.equal(calls,3);
    assert.equal(fixture.manager.pendingAuthorityRevocations.size,0);
    await fixture.manager.close();
    assert.equal(calls,3,
      'already revoked epoch is not retried during shutdown');
  }finally {await fixture.close()}
});
