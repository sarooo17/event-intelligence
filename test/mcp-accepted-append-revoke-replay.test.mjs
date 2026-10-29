import assert from 'node:assert/strict';
import test from 'node:test';
import { McpEventsClientManager } from '../scripts/lib/mcp-events-client.mjs';

function deferred() {
  let resolve;
  return { promise:new Promise(r=>{resolve=r}), resolve:()=>resolve() };
}
const descriptor={
  name:'invoice.changed',delivery:['poll'],inputSchema:{type:'object'},
  payloadSchema:{type:'object'},
};
const event={
  eventId:'provider-event-one',name:'invoice.changed',
  timestamp:'2026-10-29T12:00:00.000Z',data:{value:42},
};
const subscription={
  subscriptionId:'invoice-subscription',eventName:descriptor.name,
  arguments:{},descriptor,consumerRefs:['invoice-trigger@1:c'],
};

test('revoke racing a durably accepted append finishes CEP once without cursor write',async()=>{
  const appendEntered=deferred(),releaseAppend=deferred();
  const durableIds=new Set(),changes={appended:0,activated:0};
  const store={
    async appendMcpOccurrence(serverId,occurrence){
      appendEntered.resolve();
      await releaseAppend.promise;
      changes.appended++;
      if(durableIds.has(occurrence.eventId))return {accepted:false};
      durableIds.add(occurrence.eventId);
      return {accepted:true};
    },
    async listEventSources(){return []},
  };
  const manager=new McpEventsClientManager({
    store,registerEventSource:async()=>{},
    compositeEventConsumer:{async ingestMcpOccurrence(){changes.activated++}},
  });
  const add=()=>manager.addConnection({
    connectionId:'session',serverId:'untrusted-provider',
    request:async()=>({}),getCapabilities:async()=>({}),
  });
  const original=add();
  const context=await manager.scopeContext(original);
  const acceptedBeforeRevoke=manager.ingestOccurrence(
    original,context,subscription,event,
  );
  await appendEntered.promise;
  await manager.detachConnection('session');
  // Revocation synchronously refuses any later calls from the OLD session.
  const forbidden=await manager.ingestOccurrence(
    original,context,subscription,{...event,eventId:'late-after-revoke'},
  );
  assert.deepEqual(forbidden,{accepted:false,reason:'detached'});
  const replacement=add();
  releaseAppend.resolve();
  const delivered=await acceptedBeforeRevoke;
  assert.equal(delivered.accepted,true);
  assert.equal(changes.activated,1);
  assert.equal(changes.appended,1);
  // Durable dedup on replay cannot erase an already accepted activation.
  const reprocessed=await manager.ingestOccurrence(
    replacement,context,subscription,event,
  );
  assert.equal(reprocessed.accepted,false);
  assert.equal(changes.activated,1);
  assert.equal(changes.appended,2);
  assert.equal(durableIds.size,1);
});

test('revocation before append admission still rejects with no side effects',async()=>{
  let count=0;
  const store={async listEventSources(){return []},async appendMcpOccurrence(){count++}};
  const manager=new McpEventsClientManager({
    store,registerEventSource:async()=>{},
    compositeEventConsumer:{async ingestMcpOccurrence(){count++}},
  });
  const connection=manager.addConnection({
    connectionId:'revoked',serverId:'server',
    request:async()=>({}),getCapabilities:async()=>({}),
  });
  const context=await manager.scopeContext(connection);
  await manager.detachConnection('revoked');
  assert.deepEqual(await manager.ingestOccurrence(
    connection,context,subscription,event,
  ),{accepted:false,reason:'detached'});
  assert.equal(count,0);
});


test('detached poll accepted append stays in close drain until CEP completes',async()=>{
  const entered=deferred(),release=deferred();
  let activated=0,storeClosed=false,closeResolved=false;
  const store={
    async listTriggers(){return [{
      triggerId:'invoice-trigger',version:'1',
      clauses:[{id:'c',serverId:'untrusted-provider',event:descriptor.name,arguments:{}}],
    }]},
    async getTriggerState(){return {status:'active'}},
    async getMcpClientState(){return null},
    async listEventSources(){return []},
    async appendMcpOccurrence(){
      entered.resolve();
      await release.promise;
      if(storeClosed)throw Error('append continued after store shutdown');
      return {accepted:true};
    },
    async putMcpClientState(){throw Error('stale cursor update must not commit')},
  };
  const manager=new McpEventsClientManager({
    store,registerEventSource:async()=>{},
    compositeEventConsumer:{
      async ingestMcpOccurrence(){
        assert.equal(storeClosed,false);
        activated++;
      },
    },
  });
  manager.addConnection({
    connectionId:'session',serverId:'untrusted-provider',
    request:async()=>({events:[event],cursor:'old',hasMore:false}),
    getCapabilities:async()=>({}),
  });
  manager.descriptors.set('session',[descriptor]);
  manager.profiles.set('session',{pollMethod:'events/poll'});
  const pending=manager.pollConnection('session');
  await entered.promise;
  await manager.detachConnection('session');
  const close=manager.close().then(()=>{
    closeResolved=true;
    storeClosed=true;
  });
  await Promise.resolve();
  assert.equal(closeResolved,false,'close cannot release store before preaccepted append/CEP');
  release.resolve();
  await assert.rejects(pending,error=>error.code==='MCP_EVENTS_CONNECTION_DETACHED');
  await close;
  assert.equal(activated,1);
  assert.equal(closeResolved,true);
  assert.equal(manager.occurrenceInFlight.size,0);
});
