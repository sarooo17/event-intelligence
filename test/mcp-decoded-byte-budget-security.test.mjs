import assert from 'node:assert/strict';
import test from 'node:test';
import { McpEventsClientManager, createHostMcpEventsConnection } from '../scripts/lib/mcp-events-client.mjs';

const descriptor=Object.freeze({
  name:'item.changed',delivery:['poll','push'],inputSchema:{type:'object'},
  payloadSchema:{type:'object'},
});
const occurrence=(eventId,large=0)=>({
  eventId,name:'item.changed',timestamp:'2026-10-29T12:00:00.000Z',
  data:{note:'x'.repeat(large)},
});
function fixture({request,openEventStream,config={}}={}){
  const counters={appends:0,activations:0,states:0};
  const store={
    async listTriggers(){return [{triggerId:'tenant-trigger',version:'1',
      clauses:[{id:'c',event:'item.changed',serverId:'test-server',arguments:{}}]}]},
    async getTriggerState(){return {status:'active'};},
    async getMcpClientState(){return null;},
    async putMcpClientState(x){counters.states++;return x;},
    async appendMcpOccurrence(){counters.appends++;return {accepted:true};},
    async listEventSources(){return []},
  };
  const manager=new McpEventsClientManager({
    store,registerEventSource:async()=>{},
    compositeEventConsumer:{async ingestMcpOccurrence(){counters.activations++}},
  });
  const connection=createHostMcpEventsConnection({
    connectionId:'untrusted-source',serverId:'test-server',
    request:request??(async()=>({events:[],cursor:null,hasMore:false})),
    getCapabilities:async()=>({}),openEventStream,...config,
  });
  const added=manager.addConnection(connection);
  manager.descriptors.set(added.connectionId,[descriptor]);
  manager.profiles.set(added.connectionId,{pollMethod:'events/poll'});
  return {manager,connection:added,counters};
}
const overLimit=error=>{
  assert.equal(error.code,'MCP_EVENTS_DECODED_BYTE_LIMIT_EXCEEDED');
  assert.doesNotMatch(error.message,/x{12}|item.changed|event-\d/);
  return true;
};

test('oversized MCP poll occurrence fails before any append, consumer or cursor update',async()=>{
  const {manager,counters}=fixture({
    config:{maxOccurrenceBytes:1024},
    request:async()=>({events:[occurrence('event-oversize',1500)],
      cursor:'next',hasMore:false}),
  });
  await assert.rejects(manager.pollConnection('untrusted-source'),overLimit);
  assert.deepEqual(counters,{appends:0,activations:0,states:0});
});

test('aggregate decoded poll page byte quota rejects all items before partial append',async()=>{
  const {manager,counters}=fixture({
    config:{maxOccurrenceBytes:1024,maxPollPageBytes:1024},
    request:async()=>({events:[occurrence('event-1',610),
      occurrence('event-2',610)],cursor:'later',hasMore:false}),
  });
  await assert.rejects(manager.pollConnection('untrusted-source'),overLimit);
  assert.deepEqual(counters,{appends:0,activations:0,states:0});
});

test('within-budget MCP polling retains original contract, including cursor update',async()=>{
  const {manager,counters}=fixture({
    config:{maxOccurrenceBytes:1024,maxPollPageBytes:1024},
    request:async()=>({events:[occurrence('small',30)],
      cursor:'ok',hasMore:false}),
  });
  const results=await manager.pollConnection('untrusted-source');
  assert.equal(results[0].accepted,1);
  assert.deepEqual(counters,{appends:1,activations:1,states:1});
});

test('push and webhook callback applies same decoded byte cap before persistence',async()=>{
  let callbacks;
  const {manager,counters,connection}=fixture({
    config:{maxOccurrenceBytes:1024},
    openEventStream:async arg=>{
      callbacks=arg;
      return {close(){}};
    },
  });
  const context=await manager.scopeContext(connection);
  const subscription={subscriptionId:'push-one',eventName:'item.changed',
    arguments:{},descriptor,consumerRefs:['tenant-trigger@1:c']};
  await manager.ensureDeliverySession(connection,context,subscription,'push');
  await assert.rejects(callbacks.onEvent(occurrence('big-event',1700)),overLimit);
  assert.equal(counters.appends,0);
  assert.equal(counters.activations,0);
  const before=counters.states;
  await assert.rejects(callbacks.onActive({cursor:'x'.repeat(1500)}),overLimit);
  assert.equal(counters.states,before);
  await callbacks.onEvent(occurrence('small-event',20));
  assert.equal(counters.appends,1);
  assert.equal(counters.activations,1);
  await manager.detachConnection('untrusted-source');
});

test('invalid budget configuration fails closed at connection admission',()=>{
  for(const options of [
    {maxOccurrenceBytes:0},{maxOccurrenceBytes:99999999},
    {maxPollPageBytes:-1},{maxDiscoveryBytes:NaN},
  ]){
    assert.throws(()=>fixture({config:options}),/maxOccurrenceBytes|maxPollPageBytes|maxDiscoveryBytes/);
  }
});
