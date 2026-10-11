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


test('malformed cursor objects, arrays or numbers fail before string conversion',async()=>{
  for (const invalid of [{cursor:'bad'},new Array(100000).fill('x'),42]) {
    const f=fixture(()=>({events:[descriptor(1)],nextCursor:invalid}));
    await assert.rejects(
      ()=>f.manager.discoverConnection('untrusted-source'),
      error=>error.code==='MCP_EVENTS_DISCOVERY_CURSOR_INVALID',
    );
    assert.equal(f.calls,1);
    assert.equal(f.registered.length,0);
  }
});

test('cursor cycle takes priority over parsing duplicated or corrupt descriptors',async()=>{
  const f=fixture((params,n)=>({
    events:n===1?[descriptor(1)]:[
      descriptor(1),{not:'a valid descriptor'},
    ],
    nextCursor:'loop-1',
  }));
  await assert.rejects(
    ()=>f.manager.discoverConnection('untrusted-source'),
    rejected,
  );
  assert.equal(f.calls,2);
  assert.equal(f.registered.length,0);
});


test('events/list rejects top-level Proxy and getter properties without executing traps', async () => {
  let invoked=0;
  const getterPage={ nextCursor:null };
  Object.defineProperty(getterPage,'events',{
    enumerable:true,
    get(){invoked++;return [descriptor(1)];},
  });
  const cursorPage={events:[descriptor(1)]};
  Object.defineProperty(cursorPage,'nextCursor',{
    enumerable:true,
    get(){invoked++;return 'forged';},
  });
  const outerProxy=new Proxy({events:[descriptor(1)]},{
    get(){invoked++;return null;},
    getOwnPropertyDescriptor(){invoked++;return undefined;},
  });
  const arrayProxy=new Proxy([descriptor(1)],{
    get(){invoked++;return [];},
    getOwnPropertyDescriptor(){invoked++;return undefined;},
  });
  for(const page of [getterPage,cursorPage,outerProxy,{events:arrayProxy}]) {
    const f=fixture(()=>page);
    await assert.rejects(
      ()=>f.manager.discoverConnection('untrusted-source'),
      error=>error.code==='MCP_EVENTS_DISCOVERY_PAGE_INVALID',
    );
    assert.equal(f.registered.length,0);
  }
  assert.equal(invoked,0);
});

test('events/list rejects descriptor and schema getters or proxies before source mutation',async()=>{
  let invoked=0;
  const getterName=descriptor(1);
  Object.defineProperty(getterName,'name',{
    enumerable:true,
    get(){invoked++;return 'forged';},
  });
  const getterSchema=descriptor(1);
  Object.defineProperty(getterSchema.payloadSchema,'secret',{
    enumerable:true,
    get(){invoked++;return 'private';},
  });
  const proxy=new Proxy(descriptor(1),{
    get(){invoked++;return 'forged';},
    ownKeys(){invoked++;return ['name'];},
  });
  for(const unsafe of [getterName,getterSchema,proxy]) {
    const f=fixture(()=>({events:[unsafe]}));
    await assert.rejects(
      ()=>f.manager.discoverConnection('untrusted-source'),
      error=>error.code==='EVENT_UNTRUSTED_DATA_INVALID',
    );
    assert.equal(f.registered.length,0);
  }
  assert.equal(invoked,0);
});

test('events/list uses the bounded own slots instead of producer-defined iterators',async()=>{
  let iterated=0;
  const events=[descriptor(1)];
  Object.defineProperty(events,Symbol.iterator,{
    configurable:true,enumerable:false,
    value:function*(){iterated++;yield descriptor(999);},
  });
  const f=fixture(()=>({events,nextCursor:null}));
  const discovered=await f.manager.discoverConnection('untrusted-source');
  assert.deepEqual(discovered.map(x=>x.name),['security.event.1']);
  assert.equal(f.registered.length,1);
  assert.equal(iterated,0);
});

test('events/list snapshots nested descriptor schemas before any asynchronous registration',async()=>{
  let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;});
  const proceed=new Promise(resolve=>{release=resolve;});
  const raw=descriptor(1);
  raw.payloadSchema={type:'object',properties:{owner:{const:'initial-owner'}}};
  const f=fixture(()=>({events:[raw]}));
  f.manager.registerEventSource=async source=>{
    enter();
    await proceed;
    f.registered.push(source);
  };
  const pending=f.manager.discoverConnection('untrusted-source');
  await entered;
  raw.name='forged-name';
  raw.payloadSchema.properties.owner.const='other-owner';
  release();
  const discovered=await pending;
  assert.equal(discovered[0].name,'security.event.1');
  assert.equal(f.registered.length,1);
  assert.equal(f.registered[0].eventName,'security.event.1');
  assert.equal(f.registered[0].payloadSchema.properties.owner.const,'initial-owner');
});
