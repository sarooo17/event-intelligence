import assert from 'node:assert/strict';
import test from 'node:test';
import {McpEventsClientManager} from '../scripts/lib/mcp-events-client.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PersistentEventStore} from '../scripts/lib/persistent-event-store.mjs';
import {createLocalEventIntelligenceRuntime} from '../scripts/lib/local-event-intelligence-runtime.mjs';

const epoch='host-controlled-epoch-'.padEnd(48,'r');
const descriptor={name:'safe.changed',delivery:['poll'],
  inputSchema:{type:'object'},payloadSchema:{type:'object'}};
const event={eventId:'e1',name:'safe.changed',
  timestamp:'2026-10-29T14:00:00.000Z',data:{valid:true}};

function fixture(){
  const events={begin:[],revoke:[],append:[],consume:0};
  const store={
    requireMcpSessionFence:true,
    async beginMcpConnectionAuthority(x){events.begin.push(x)},
    async revokeMcpConnectionAuthority(x){events.revoke.push(x);return true},
    async listTriggers(){return []},
    async getTriggerState(){return {status:'active'}},
    async listEventSources(){return []},
    async getMcpClientState(){return null},
    async appendMcpOccurrence(_server,occurrence,_sub,authority){
      events.append.push(authority);
      return {accepted:true,event:occurrence};
    },
  };
  const manager=new McpEventsClientManager({
    store,registerEventSource:async()=>{},
    compositeEventConsumer:{async ingestMcpOccurrence(){events.consume++}},
  });
  const opts={connectionId:'session',serverId:'provider',
    authorityEpoch:epoch,
    request:async()=>({events:[]}),
    getCapabilities:async()=>({}),
  };
  return {events,store,manager,opts};
}
test('host attach prepares PG shared authority before event append, then revokes on detach',async()=>{
  const {events,manager,opts}=fixture();
  const add=await manager.attachConnection(opts,{discover:false});
  assert.equal(add.connectionId,'session');
  assert.deepEqual(events.begin,[{connectionId:'session',epoch}]);
  const connection=manager.connections.get('session');
  const context=await manager.scopeContext(connection);
  const subscription={subscriptionId:'sub',eventName:descriptor.name,
    descriptor,arguments:{},consumerRefs:[]};
  const accepted=await manager.ingestOccurrence(connection,context,subscription,event);
  assert.equal(accepted.accepted,true);
  assert.deepEqual(events.append,[{connectionId:'session',epoch}]);
  assert.equal(events.consume,1);
  await manager.detachConnection('session');
  assert.deepEqual(events.revoke,[{connectionId:'session',epoch}]);
  assert.deepEqual(await manager.ingestOccurrence(connection,context,subscription,event),
    {accepted:false,reason:'detached'});
  await manager.close();
});
test('fenced connection without a strict shared store fails closed before discovery',async()=>{
  const {manager,store,events,opts}=fixture();
  store.requireMcpSessionFence=false;
  await assert.rejects(manager.attachConnection(opts,{discover:false}),
    /enabled PostgreSQL authority fence/);
  assert.equal(events.begin.length,0);
  await manager.close();
});
test('preloaded host connection authority registers before any initial provider discovery',async()=>{
  const {store,opts,events}=fixture();
  const manager=new McpEventsClientManager({
    store,registerEventSource:async()=>{},
    compositeEventConsumer:{async ingestMcpOccurrence(){}},
    connections:[opts],
  });
  await manager.prepareConnectionAuthorities();
  assert.deepEqual(events.begin,[{connectionId:'session',epoch}]);
  await manager.close();
  assert.deepEqual(events.revoke,[{connectionId:'session',epoch}]);
});

test('close drains pending scope registration before database revoke',async()=>{
  const {store,opts,events}=fixture();
  let started,release;
  const entered=new Promise(resolve=>{started=resolve});
  const gate=new Promise(resolve=>{release=resolve});
  const manager=new McpEventsClientManager({
    store,registerEventSource:async()=>{},
    resolveScope:async()=>{started();await gate;return {
      store,compositeEventConsumer:{async ingestMcpOccurrence(){}},
      triggerControl:null,
    }},
    compositeEventConsumer:{async ingestMcpOccurrence(){}},
  });
  const attach=manager.attachConnection(opts,{discover:false});
  await entered;
  const shutdown=manager.close();
  release();
  await assert.rejects(attach,e=>e.code==='EI_HOST_CLOSED');
  await shutdown;
  assert.deepEqual(events.begin,[{connectionId:'session',epoch}]);
  assert.deepEqual(events.revoke,[{connectionId:'session',epoch}],
    'final revoke must commit after pending registration is settled');
});

test('runtime startup failure unwinds already registered epochs without returning a live host',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ei-session-bootstrap-'));
  const store=new PersistentEventStore(dir);
  const registered=[],revoked=[];
  store.requireMcpSessionFence=true;
  store.beginMcpConnectionAuthority=async({connectionId})=>{
    if(connectionId==='conflict') {
      const e=new Error('MCP session epoch conflict');
      e.code='MCP_SESSION_EPOCH_CONFLICT';throw e;
    }
    registered.push(connectionId);
  };
  store.revokeMcpConnectionAuthority=async({connectionId})=>{
    revoked.push(connectionId);
    return true;
  };
  const connection=id=>({
    connectionId:id,serverId:id,authorityEpoch:epoch,
    request:async()=>({events:[]}),getCapabilities:async()=>({}),
  });
  try{
    await assert.rejects(()=>createLocalEventIntelligenceRuntime({
      store,mcpEventConnections:[connection('registered'),connection('conflict')],
      env:{EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE:'false'},
    }),e=>e.code==='MCP_SESSION_EPOCH_CONFLICT');
    assert.deepEqual(registered,['registered']);
    assert.ok(revoked.includes('registered'),
      'failure must never leave a successfully enrolled previous host epoch active');
  }finally{
    await store.close?.();
    await rm(dir,{recursive:true,force:true});
  }
});

test('disabled host connection with an epoch remains a no-op, not an error',async()=>{
  const {manager,opts,events}=fixture();
  const answer=await manager.attachConnection({...opts,enabled:false},{discover:false});
  assert.equal(answer.connectionId,'session');
  assert.deepEqual(answer.events,[]);
  assert.equal(manager.connections.size,0);
  assert.equal(events.begin.length,0);
  assert.equal(events.revoke.length,0);
  await manager.close();
});


test('shutdown revokes all healthy scopes, drains admitted work and retries failed epoch',async()=>{
  const attempts=[],contexts=[];
  let failFirst=true,firstCloseResult;
  const scopes=new Map(['scope-a','scope-b','scope-c'].map(scope=>{
    const store={
      requireMcpSessionFence:true,
      async revokeMcpConnectionAuthority({connectionId,epoch}) {
        attempts.push(connectionId);
        if(connectionId==='a'&&failFirst)throw Error('temporary PG outage SECRET');
        return true;
      },
    };
    return [scope,{store,compositeEventConsumer:{async ingestMcpOccurrence(){}}}];
  }));
  const opts=(id,scopeId)=>({
    connectionId:id,serverId:'server-'+id,scopeId,
    authorityEpoch:'host-epoch-'+id.padEnd(42,'q'),
    request:async()=>({events:[]}),getCapabilities:async()=>({}),
  });
  const manager=new McpEventsClientManager({
    store:scopes.get('scope-a').store,
    registerEventSource:async()=>{},
    compositeEventConsumer:{async ingestMcpOccurrence(){}},
    resolveScope:async scope=>{
      contexts.push(scope);return scopes.get(scope);
    },
    connections:[opts('a','scope-a'),opts('b','scope-b'),opts('c','scope-c')],
  });
  await assert.rejects(()=>manager.close(),e=>{
    assert.equal(e.code,'MCP_SESSION_REVOCATION_INCOMPLETE');
    assert.ok(!e.message.includes('SECRET'));
    return true;
  });
  assert.deepEqual(attempts,['a','b','c'],
    'one failed scope must never strand other healthy scope epochs');
  assert.equal(manager.pendingAuthorityRevocations.size,1);
  failFirst=false;
  await manager.close();
  assert.deepEqual(attempts,['a','b','c','a']);
  assert.equal(manager.pendingAuthorityRevocations.size,0);
});

test('failed detach must retain authoritative epoch for later shutdown retry',async()=>{
  let failure=true,attempts=0;
  const {manager,store,opts}=fixture();
  store.revokeMcpConnectionAuthority=async()=>{
    attempts++;
    if(failure)throw Error('external database unavailable');
    return true;
  };
  await manager.attachConnection(opts,{discover:false});
  await assert.rejects(manager.detachConnection('session'),/external database unavailable/);
  assert.equal(manager.connections.has('session'),false);
  assert.equal(manager.pendingAuthorityRevocations.size,1);
  failure=false;
  await manager.close();
  assert.equal(manager.pendingAuthorityRevocations.size,0);
  assert.equal(attempts,2);
});
