import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { McpEventsClientManager } from '../scripts/lib/mcp-events-client.mjs';

for (const delivery of ['push', 'webhook']) {
  test(delivery + ' leaked provider callbacks cannot ingest after manager close', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-retained-callback-'));
    const store = new PersistentEventStore(dir);
    let manager;
    let callbacks;
    let transportCloses = 0;
    let ingested = 0;
    let errors = 0;
    try {
      await store.init();
      const consumer = {
        async ingestMcpOccurrence() { ingested++; },
      };
      manager = new McpEventsClientManager({
        store,
        compositeEventConsumer: consumer,
        registerEventSource: async () => {},
      });
      const connection = manager.addConnection({
        connectionId: 'source', serverId: 'provider',
        getCapabilities: async () => ({ extensions: {
          'io.modelcontextprotocol/events': {},
        } }),
        request: async () => ({ events: [], cursor: null }),
        ...(delivery === 'push'
          ? { openEventStream: hooks => {
              callbacks = hooks;
              return { close() { transportCloses++; } };
            } }
          : { createWebhookSubscription: hooks => {
              callbacks = hooks;
              return { close() { transportCloses++; } };
            } }),
      });
      const context = { store, compositeEventConsumer: consumer };
      const subscription = {
        subscriptionId: 'sub-1',eventName:'work.changed',arguments:{},
        descriptor:{
          name:'work.changed',delivery:[delivery],
          payloadSchema:{type:'object'},
        },
        consumerRefs:['trigger-1'],
      };
      const opened = await manager.ensureDeliverySession(
        connection,context,subscription,delivery);
      assert.equal(opened.status,'active');
      assert.ok(callbacks,'provider must receive callbacks');
      // An accepted active-page callback must snapshot the producer's
      // cursor synchronously, before the caller can rewrite its object.
      const producerUpdate = { cursor:'accepted-cursor', truncated:false };
      const accepted = callbacks.onActive(producerUpdate);
      producerUpdate.cursor = 'forged-later';
      await accepted;
      assert.equal(store.getMcpClientState('source','work.changed',{}).cursor,
        'accepted-cursor', 'callback must snapshot own input before yielding');
      const sourceBefore = store.getMcpClientState('source','work.changed',{});
      assert.ok(sourceBefore);
      const before = JSON.stringify(sourceBefore);
      const close = manager.close();
      await close;
      assert.equal(transportCloses,1);
      // Provider retains callback references despite its transport handle
      // having been retired. No untrusted body should be parsed or written.
      await callbacks.onEvent({ malicious: new Proxy({}, {
        get() { throw new Error('late input trap must never execute'); },
      }) });
      await callbacks.onActive({ cursor:'late' });
      await callbacks.onGap({ truncated:true, cursor:'late' });
      callbacks.onError(new Error('private-provider-secret'));
      await callbacks.onTerminated({});
      assert.equal(ingested,0);
      assert.equal(errors,0);
      assert.equal(JSON.stringify(store.getMcpClientState(
        'source','work.changed',{})),before);
    }finally{
      await manager?.close();
      await store.close();
      await rm(dir,{recursive:true,force:true});
    }
  });
}
