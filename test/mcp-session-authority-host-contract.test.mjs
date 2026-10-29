import assert from 'node:assert/strict';
import test from 'node:test';
import {McpEventsClientManager} from '../scripts/lib/mcp-events-client.mjs';

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
