import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  createActivationDispatcher,createDeterministicReceiptId,
} from 'mcp-event-intelligence/embedded';
import {
  createHeadlessJobExample,createHeadlessJobRuntime,
} from '../examples/host-adapter/headless-job-host.mjs';

// Valid canonical ActivationEnvelope v2. The *target* comes from an
// authorized trigger; external event data does not choose a host identity.
const activation={
  activationVersion:'2',
  wake:{wakeId:'headless-wake-1',status:'queued',runtimeReceiptId:null,
    matchedAt:'2026-10-30T12:00:00.000Z'},
  target:{runtime:'host',kind:'job',id:'job-1'},
  trigger:{triggerId:'headless-trigger',version:'1',description:null,
    pattern:{version:'2',root:{kind:'event',ref:'event_1'},partitionBy:[],
      selection:{overlap:'disallow',afterMatch:'skipPastLast',
        maxMatchesPerEvent:10},
      execution:{maxCandidates:512,maxSemanticEvaluations:16,
        maxBufferedEvents:10000}},
    lifecycle:{oneShot:true,cooldownMs:0,completeOnGoal:false}},
  continuation:{instruction:'Continue background job',
    contextPolicy:{evidence:'matched_events',maxEvents:20,includeData:true}},
  match:{matchId:'match-1',status:'matched',partitionKey:null,
    openedAt:'2026-10-30T12:00:00.000Z',
    updatedAt:'2026-10-30T12:00:00.000Z'},
  evidence:[],trust:{continuation:'configured_trigger_instruction',
    evidence:'untrusted_external_signal'},
};
test('headless ports fail closed without authority or durable receipt callbacks',async()=>{
  for(const property of ['receiptNamespace','resolveLiveJob','readReceipt','enqueueAtomic']){
    const setup={receiptNamespace:'test-scope',
      resolveLiveJob:()=>({job:'job-1'}),
      readReceipt:async()=>null,enqueueAtomic:async()=>({
        receiptId:'unused',durable:true,
      })};
    delete setup[property];
    assert.throws(()=>createHeadlessJobRuntime(setup),TypeError);
  }
  const denied=createHeadlessJobRuntime({
    receiptNamespace:'n',resolveLiveJob:()=>null,readReceipt:()=>null,
    enqueueAtomic:()=>null,
  });
  assert.equal(await denied.hasReceipt('not-known'),false);
});
test('reference host restores a committed receipt after a lost ack and refuses revoked jobs',async()=>{
  const rows=new Map();
  let active=true;
  let writes=0;
  let loseOnce=true;
  const runtime=createHeadlessJobRuntime({
    receiptNamespace:'headless-tenant-A',
    resolveLiveJob:async target=>active&&target.id==='job-1'
      ?{id:'job-1',scopeId:'org-A/workspace-1'}:null,
    readReceipt:async id=>rows.get(id)??null,
    enqueueAtomic:async ({receiptId,target})=>{
      assert.equal(target.scopeId,'org-A/workspace-1');
      const duplicate=rows.has(receiptId);
      if(!duplicate){rows.set(receiptId,{receiptId});writes++;}
      if(loseOnce){loseOnce=false;throw new Error('host post-commit/pre-ack');}
      return {receiptId,durable:true,duplicate};
    },
  });
  assert.equal('resolveContext' in runtime,false);
  assert.equal('control' in runtime,false);
  const dispatch=createActivationDispatcher(runtime);
  const first=await dispatch({wake_id:activation.wake.wakeId},activation);
  assert.equal(first.duplicate,true);
  const expected=createDeterministicReceiptId(
    'headless-tenant-A',activation.wake.wakeId);
  assert.equal(first.runtimeReceiptId,expected);
  const replay=await dispatch({wake_id:activation.wake.wakeId},activation);
  assert.equal(replay.duplicate,true);
  assert.equal(writes,1);
  active=false;
  const other={...activation,wake:{...activation.wake,wakeId:'headless-wake-2'}};
  await assert.rejects(
    dispatch({wake_id:other.wake.wakeId},other),
    e=>e.code==='EVENT_ACTIVATION_TARGET_UNAVAILABLE',
  );
  assert.equal(writes,1);
  await assert.rejects(dispatch({wake_id:'forged-wake'},activation),
    e=>e.code==='EVENT_ACTIVATION_WAKE_ID_MISMATCH');
});
test('actual headless facade integrates real CEP trigger and host job enqueue with zero agent tools',{
  timeout:20000,
},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ei-headless-reference-'));
  let app;
  t.after(async()=>{
    try{await app?.close();}
    finally{await rm(dir,{recursive:true,force:true});}
  });
  const jobs=new Map();
  const events=[];
  app=await createHeadlessJobExample({
    dataDir:dir,
    env:{TYPESAFE_API_KEY:'',RUNTIME_WAKE_TARGETS_JSON:'{}',
      TEMPORAL_TICK_MS:'100000',WAKE_RETRY_TICK_MS:'100'},
    receiptNamespace:'org-headless/workspace-1',
    listConnections:async()=>[],
    resolveLiveJob:async target=>target.id==='job-1'&&target.kind==='job'
      ?{id:'job-1',scopeId:'org-headless/workspace-1'}:null,
    readReceipt:async id=>jobs.get(id)??null,
    enqueueAtomic:async ({receiptId,target,activation:actual})=>{
      if(target.scopeId!=='org-headless/workspace-1')
        throw Error('HOST_SCOPE_DENIED');
      const duplicate=jobs.has(receiptId);
      if(!duplicate){jobs.set(receiptId,{receiptId,target,wakeId:actual.wake.wakeId});
        events.push(actual.wake.wakeId);}
      return {receiptId,durable:true,duplicate};
    },
  });
  assert.deepEqual(app.integration.tools,[]);
  const owner={type:'system',principal_id:'headless-reference-owner'};
  await app.host.triggerControl.registerEventSource({
    sourceId:'headless:order-paid',
    connectionId:'headless-events',serverId:'headless-provider',
    eventName:'headless.order.paid',delivery:['poll'],
    payloadSchema:{type:'object',required:['value'],additionalProperties:false,
      properties:{value:{type:'number'}}},enabled:true,
  },owner);
  const planned=await app.host.planTrigger({
    triggerId:'headless-job-wake',
    events:[{id:'value',event:'headless.order.paid',serverId:'headless-provider',
      where:[{path:'value',op:'gt',value:5}]}],
    lifecycle:{oneShot:true},
    target:{runtime:'headless-host',kind:'job',id:'job-1'},
    continuation:{instruction:'Queue the authorized job'},
  });
  await app.host.triggerControl.createTrigger({
    definition:planned.definition,connectionIds:planned.connectionIds,
    actor:owner,owner,
  });
  await app.host.runtime.compositeEventConsumer.ingestCorrelatable({
    traceId:'headless-reference-event',sourceEventId:'order-1',
    name:'headless.order.paid',serverId:'headless-provider',
    provider:'headless-reference',occurredAt:new Date().toISOString(),
    data:{value:10},
  });
  for(let i=0;i<70&&events.length===0;i++)
    await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(events.length,1,'real EI match must resume one host job');
  assert.equal(jobs.size,1);
  assert.equal(events[0],jobs.values().next().value.wakeId);
});
