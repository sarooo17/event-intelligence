import assert from 'node:assert/strict';
import test from 'node:test';
import { McpEventsClientManager } from '../scripts/lib/mcp-events-client.mjs';

test('mismatched untrusted MCP occurrence name cannot leak in error or enqueue effects', async () => {
  const seen={ appends:0,activations:0 };
  const store={
    async listEventSources(){return[]},
    async appendMcpOccurrence(){seen.appends++;return{accepted:true}},
  };
  const manager=new McpEventsClientManager({
    store,
    compositeEventConsumer:{
      async ingestMcpOccurrence(){seen.activations++;},
    },
    registerEventSource:async()=>{},
  });
  const connection=manager.addConnection({
    connectionId:'provider-private-session',
    serverId:'provider',
    request:async()=>({}),getCapabilities:async()=>({}),
  });
  const context={store,compositeEventConsumer:manager.compositeEventConsumer};
  const privateName='private.credential_tag_only_provider_knows';
  const descriptorName='private.subscription_secret_tag';
  const subscription={
    subscriptionId:'subscription',
    eventName:descriptorName,
    descriptor:{name:descriptorName,payloadSchema:{type:'object'}},
    arguments:{},
  };
  const event={
    eventId:'event-mismatch-1',
    name:privateName,
    timestamp:'2026-10-27T18:00:00.000Z',
    data:{customerKey:'also-not-in-errors'},
  };
  await assert.rejects(
    manager.ingestOccurrence(connection,context,subscription,event),
    error=>{
      assert.equal(error.code,'MCP_EVENTS_OCCURRENCE_NAME_MISMATCH');
      assert.equal(error.message,'MCP Events occurrence does not match subscription');
      const visible=[error.name,error.message,error.stack,error.code,
        JSON.stringify(Object.getOwnPropertyDescriptors(error))].join('|');
      for(const token of [privateName,descriptorName,'also-not-in-errors']) {
        assert.equal(visible.includes(token),false,'untrusted event data leaked');
      }
      return true;
    },
  );
  assert.deepEqual(seen,{appends:0,activations:0});
});
