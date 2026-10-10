import assert from 'node:assert/strict';
import test from 'node:test';
import {
  McpEventsClientManager,
  MAX_MCP_EVENT_DISCOVERY_PAGES,
  MAX_MCP_EVENT_DISCOVERY_SOURCES,
  MAX_MCP_EVENT_CURSOR_BYTES,
} from '../scripts/lib/mcp-events-client.mjs';

function descriptor(n) {
  return {
    name:'security.event.'+n,
    delivery:['poll'],
    inputSchema:{type:'object'},
    payloadSchema:{type:'object'},
  };
}
function fixture(request) {
  const registered=[];
  const stored=[];
  const manager=new McpEventsClientManager({
    store:{
      async listEventSources(){return stored;},
    },
    compositeEventConsumer:{},
    registerEventSource:async(source)=>{
      registered.push(source);
      stored.push(source);
    },
  });
  let calls=0;
  manager.addConnection({
    connectionId:'untrusted-source',
    serverId:'mcp-remote',
    request:async(method,params)=>{
      calls++;
      assert.equal(method,'events/list');
      return request(params,calls);
    },
    getCapabilities:async()=>({
      extensions:{
        'io.modelcontextprotocol/events':{listChanged:false},
      },
    }),
  });
  return {manager,registered,get calls(){return calls;}};
}
function rejected(error) {
  assert.equal(error.code,'MCP_EVENTS_DISCOVERY_LIMIT_EXCEEDED');
  return true;
}

test('reject cyclic events/list cursor without registering a partial catalogue',async()=>{
  const f=fixture((params,n)=>({
    events:[descriptor(n)],
    nextCursor:'same-cursor',
  }));
  await assert.rejects(()=>f.manager.discoverConnection('untrusted-source'),rejected);
  assert.equal(f.calls,2);
  assert.equal(f.registered.length,0);
});

test('reject more than the allowed number of pages before issuing another RPC',async()=>{
  const f=fixture((params,n)=>({
    events:[descriptor(n)],
    nextCursor:'cursor-'+n,
  }));
  await assert.rejects(()=>f.manager.discoverConnection('untrusted-source'),rejected);
  assert.equal(f.calls,MAX_MCP_EVENT_DISCOVERY_PAGES);
  assert.equal(f.registered.length,0);
});

test('reject oversized pages and excessive total descriptors before registration',async()=>{
  const tooMany=fixture(()=>({
    events:Array.from({length:MAX_MCP_EVENT_DISCOVERY_SOURCES+1},(_,i)=>descriptor(i)),
    nextCursor:null,
  }));
  await assert.rejects(()=>tooMany.manager.discoverConnection('untrusted-source'),rejected);
  assert.equal(tooMany.registered.length,0);

  const multiPage=fixture((params,n)=>({
    events:Array.from({length:130},(_,i)=>descriptor((n-1)*130+i)),
    nextCursor:n===1?'next':null,
  }));
  await assert.rejects(()=>multiPage.manager.discoverConnection('untrusted-source'),rejected);
  assert.equal(multiPage.registered.length,0);
});

test('reject untrusted overlong opaque cursors without further requests',async()=>{
  const f=fixture(()=>({
    events:[descriptor(1)],
    nextCursor:'x'.repeat(MAX_MCP_EVENT_CURSOR_BYTES+1),
  }));
  await assert.rejects(()=>f.manager.discoverConnection('untrusted-source'),rejected);
  assert.equal(f.calls,1);
  assert.equal(f.registered.length,0);
});

test('finite catalogue at source limit continues to register normally',async()=>{
  const f=fixture(()=>({
    events:Array.from({length:MAX_MCP_EVENT_DISCOVERY_SOURCES},(_,i)=>descriptor(i)),
  }));
  const result=await f.manager.discoverConnection('untrusted-source');
  assert.equal(result.length,MAX_MCP_EVENT_DISCOVERY_SOURCES);
  assert.equal(f.registered.length,MAX_MCP_EVENT_DISCOVERY_SOURCES);
  assert.equal(f.calls,1);
});
