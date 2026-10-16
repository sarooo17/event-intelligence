import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCP_EVENTS_ERROR,
  createMcpEventsProvider,
} from '../dist/src/mcpEvents/provider.js';
import { ExperimentalMcpEventsServer } from '../dist/src/mcpEvents/server.js';

const call=(id,method,params)=>({
  jsonrpc:'2.0',id,method,...(params===undefined?{}:{params}),
});
const occurrence=(id)=>({
  eventId:id,name:'updates.recorded',
  timestamp:'2026-10-16T09:00:00.000Z',data:{id},
});
const descriptor={
  name:'updates.recorded',description:'Safe updates',delivery:['poll'],
  inputSchema:{type:'object',additionalProperties:false},
  payloadSchema:{type:'object'},
};

test('draft SEP error family and provider wire envelopes are explicit',async()=>{
  assert.deepEqual({
    NOT_FOUND:MCP_EVENTS_ERROR.NOT_FOUND,
    FORBIDDEN:MCP_EVENTS_ERROR.FORBIDDEN,
    RESOURCE_EXHAUSTED:MCP_EVENTS_ERROR.RESOURCE_EXHAUSTED,
    UNSUPPORTED:MCP_EVENTS_ERROR.UNSUPPORTED,
    CALLBACK_ENDPOINT_ERROR:MCP_EVENTS_ERROR.CALLBACK_ENDPOINT_ERROR,
  },{
    NOT_FOUND:-32023,FORBIDDEN:-32024,RESOURCE_EXHAUSTED:-32025,
    UNSUPPORTED:-32026,CALLBACK_ENDPOINT_ERROR:-32027,
  });
  let invocations=0, seen=[];
  const provider=createMcpEventsProvider({
    events:[{descriptor,poll:({cursor,maxEvents})=>{
      invocations++;seen.push({cursor,maxEvents});
      // Deliberately omit cursor: draft semantics mean null.
      return {events:[],hasMore:false,nextPollMs:1100};
    }}],
  });
  const list=await provider.handleRequest(call(1,'events/list'));
  assert.equal(list.result.resultType,'complete');
  assert.equal(list.result.events[0].name,descriptor.name);
  const bootstrap=await provider.handleRequest(call(2,'events/poll',{
    name:descriptor.name,cursor:null,maxEvents:5,
  }));
  assert.equal(bootstrap.result.resultType,'complete');
  assert.equal(bootstrap.result.cursor,null);
  assert.deepEqual(seen,[{cursor:null,maxEvents:5}]);
  const omitted=await provider.handleRequest(call(3,'events/poll',{
    name:descriptor.name,
  }));
  assert.equal(omitted.result.cursor,null);
  assert.deepEqual(seen[1],{cursor:null,maxEvents:50});

  for(const invalid of [0,123,true,{},[],false]){
    const response=await provider.handleRequest(call(4,'events/poll',{
      name:descriptor.name,cursor:invalid,
    }));
    assert.equal(response.error.code,-32602);
  }
  assert.equal(invocations,2,'invalid cursor must never invoke provider');
  const unknown=await provider.handleRequest(call(5,'events/poll',{
    name:'not.in.catalog',cursor:null,
  }));
  assert.equal(unknown.error.code,-32023);
  assert.deepEqual(unknown.error.data,{kind:'event'});
  assert.equal((await provider.handleRequest(call(6,'events/stream'))).error.code,-32601);
  for(const maxEvents of [0,501,1.5,-3,'5']){
    const response=await provider.handleRequest(call(7,'events/poll',{
      name:descriptor.name,cursor:null,maxEvents,
    }));
    assert.equal(response.error.code,-32602);
  }
  assert.equal(invocations,2);
});

test('low-level server has the same draft wire semantics with bounded paging',async()=>{
  const records=[
    {sequence:1,serverId:'fixture',event:occurrence('e1')},
    {sequence:2,serverId:'fixture',event:occurrence('e2')},
    {sequence:3,serverId:'fixture',event:occurrence('e3')},
  ];
  let reads=0;
  const server=new ExperimentalMcpEventsServer({
    latestMcpEventSequence:()=>3,
    listMcpOccurrencesAfter:async sequence=>{
      reads++;
      return records.filter(x=>x.sequence>sequence);
    },
  });
  server.registerEvent({descriptor,matcher:()=>true});
  const list=await server.handleRequest(call(1,'events/list'));
  assert.equal(list.result.resultType,'complete');
  assert.deepEqual(list.result.events.map(x=>x.name),[descriptor.name]);

  for(const params of [{name:descriptor.name,cursor:null},
    {name:descriptor.name}]) {
    const first=await server.handleRequest(call(2,'events/poll',params));
    assert.equal(first.result.resultType,'complete');
    assert.deepEqual(first.result.events,[]);
    assert.equal(first.result.cursor,'mcp-events-v1:3');
  }

  const page=await server.handleRequest(call(3,'events/poll',{
    name:descriptor.name,cursor:'mcp-events-v1:0',maxEvents:1,
  }));
  assert.equal(page.result.resultType,'complete');
  assert.deepEqual(page.result.events.map(x=>x.eventId),['e1']);
  assert.equal(page.result.hasMore,true);
  const next=await server.handleRequest(call(4,'events/poll',{
    name:descriptor.name,cursor:page.result.cursor,maxEvents:1,
  }));
  assert.deepEqual(next.result.events.map(x=>x.eventId),['e2']);
  assert.equal(next.result.hasMore,true);

  const prev=reads;
  // The public server.poll() entrypoint must never bypass the per-page
  // limit enforced by JSON-RPC handleRequest.
  for(const maxEvents of [Infinity,0,-1,501,1.5]){
    await assert.rejects(
      server.poll({name:descriptor.name,cursor:'mcp-events-v1:0',maxEvents}),
      /maxEvents/,
    );
  }
  assert.equal(reads,prev);
  for(const cursor of [123,true,{},[]]){
    const bad=await server.handleRequest(call(6,'events/poll',{
      name:descriptor.name,cursor,
    }));
    assert.equal(bad.error.code,-32602);
  }
  for(const maxEvents of [0,501,2.5,'1']){
    const bad=await server.handleRequest(call(7,'events/poll',{
      name:descriptor.name,cursor:'mcp-events-v1:0',maxEvents,
    }));
    assert.equal(bad.error.code,-32602);
  }
  assert.equal(reads,prev,'invalid args must not query durable store');
  const unknown=await server.handleRequest(call(8,'events/poll',{
    name:'missing',cursor:null,
  }));
  assert.equal(unknown.error.code,-32023);
  assert.deepEqual(unknown.error.data,{kind:'event'});
  assert.equal((await server.handleRequest(call(9,'events/stream'))).error.code,-32601);
});
