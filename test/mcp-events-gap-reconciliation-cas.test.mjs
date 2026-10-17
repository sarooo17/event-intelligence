import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { McpEventsClientManager } from '../scripts/lib/mcp-events-client.mjs';

test('JSONL gap reconciliation requires exact host-verified source revision', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-gap-cas-jsonl-'));
  let store;
  try {
    store=new PersistentEventStore(dir);
    await store.init();
    const source={connectionId:'c',serverId:'upstream',eventName:'job.failed',
      arguments:{},truncated:true,deliveryMode:'poll'};
    const first=await store.putMcpClientState(source);
    const newer=await store.putMcpClientState({...source,cursor:'new-gap'});
    assert.ok(newer.completenessRevision>first.completenessRevision);
    await assert.rejects(store.putMcpClientState({
      ...source,truncated:false,gapReconciled:true,
      reconciliationEvidenceId:'receipt-for-first-gap',
      expectedCompletenessRevision:first.completenessRevision,
    }),error=>error?.code==='MCP_EVENTS_GAP_REVISION_CONFLICT');
    const still=store.getMcpClientState('c','job.failed',{});
    assert.equal(still.completenessRevision,newer.completenessRevision);
    assert.equal(still.gapUnresolved,true);
    assert.equal(still.reconciliationEvidenceId,undefined);
    await assert.rejects(store.putMcpClientState({
      ...source,gapReconciled:true,
      reconciliationEvidenceId:'without-a-version',
    }),/expected completeness revision/);
    const accepted=await store.putMcpClientState({
      ...source,truncated:false,gapReconciled:true,
      reconciliationEvidenceId:'host-verified-current-gap',
      expectedCompletenessRevision:newer.completenessRevision,
    });
    assert.equal(accepted.gapUnresolved,false);
    assert.equal(accepted.completenessRevision,newer.completenessRevision+1);
    await store.close();
    store=new PersistentEventStore(dir);
    await store.init();
    assert.equal(store.getMcpClientState('c','job.failed').gapUnresolved,false);
    assert.equal(store.getMcpClientState('c','job.failed').completenessRevision,
      accepted.completenessRevision);
  }finally{
    await store?.close();
    await rm(dir,{recursive:true,force:true});
  }
});

test('host acknowledgement refuses a second poll gap raced after its read',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'ei-gap-cas-manager-'));
  let store;
  let manager;
  try{
    store=new PersistentEventStore(dir);
    await store.init();
    const source={connectionId:'source',serverId:'upstream',eventName:'job.failed',
      arguments:{},truncated:true,deliveryMode:'poll'};
    const first=await store.putMcpClientState(source);
    const originalGet=store.getMcpClientState.bind(store);
    let injected=false;
    const scoped={
      getMcpClientState:async(...args)=>{
        const captured=originalGet(...args);
        if(!injected) {
          injected=true;
          await store.putMcpClientState({...source,cursor:'fresh-truncated-page'});
        }
        return captured;
      },
      putMcpClientState:(input)=>store.putMcpClientState(input),
    };
    manager=new McpEventsClientManager({
      store:scoped, compositeEventConsumer:{},
    });
    manager.addConnection({connectionId:'source',serverId:'upstream',
      request:async()=>({}),getCapabilities:async()=>({})});
    await assert.rejects(manager.acknowledgeReconciledGap({
      connectionId:'source',eventName:'job.failed',arguments:{},
      evidenceId:'receipt-for-first-gap',
      expectedCompletenessRevision:first.completenessRevision,
    }),error=>error?.code==='MCP_EVENTS_GAP_REVISION_CONFLICT');
    assert.ok(injected);
    const second=originalGet('source','job.failed',{});
    assert.equal(second.gapUnresolved,true,
      'new producer gap must survive an in-flight older acknowledgement');
    assert.equal(second.reconciliationEvidenceId,undefined);
    await assert.rejects(manager.acknowledgeReconciledGap({
      connectionId:'source',eventName:'job.failed',arguments:{},
      evidenceId:'missing-revision',
    }),/expected completeness revision/);
    const repaired=await manager.acknowledgeReconciledGap({
      connectionId:'source',eventName:'job.failed',arguments:{},
      evidenceId:'host-verified-second-gap',
      expectedCompletenessRevision:second.completenessRevision,
    });
    assert.equal(repaired.gapUnresolved,false);
    assert.equal(repaired.reconciliationEvidenceId,'host-verified-second-gap');
  }finally{
    await manager?.close();
    await store?.close();
    await rm(dir,{recursive:true,force:true});
  }
});
