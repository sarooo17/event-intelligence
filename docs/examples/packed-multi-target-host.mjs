#!/usr/bin/env node
// EI-maintained packed-package consumer; NOT independent third-party adoption.
// No agent SDK, chat/session, remote provider or durable host queue is assumed.
import assert from 'node:assert/strict';
import {
  createActivationDispatcher,
  createDeterministicReceiptId,
} from 'mcp-event-intelligence/embedded';

const targets = new Map([
  ['agent-one', { kind:'agent-task', scope:'tenant-a', active:true }],
  ['graph-two', { kind:'graph-checkpoint', scope:'tenant-b', active:true }],
  ['job-three', { kind:'batch-job', scope:'tenant-a', active:true }],
]);
const receipts = new Set(); // IN-MEMORY ONLY: this example is not HA proof.
const resumed = [];
const targetFor = input => {
  const row = targets.get(input.id);
  if (!row || !row.active || row.kind !== input.kind) return null;
  return { ...row, id:input.id };
};

const dispatch = createActivationDispatcher({
  receiptId: ({ activation }) => {
    // Authoritative scope comes from host state, never from the external
    // activation evidence, incoming packet or claimed actor context.
    const resolved = targetFor(activation.target);
    if (!resolved) throw Object.assign(new Error('target revoked'),{
      code:'HOST_TARGET_REVOKED',
    });
    return createDeterministicReceiptId(
      'example-host:' + resolved.scope, activation.wake.wakeId,
    );
  },
  hasReceipt: id => receipts.has(id),
  resolveTarget: targetFor,
  deliver: ({ activation, target, receiptId }) => {
    // Real deployments must atomic-upsert both host work AND this receipt.
    if (!targetFor(activation.target)) throw Error('HOST_TARGET_REVOKED');
    const destination = target.kind === 'agent-task'
      ? { type:'agent-task', agentRunId:target.id }
      : target.kind === 'graph-checkpoint'
        ? { type:'graph-checkpoint', checkpointId:target.id }
        : { type:'batch-job', jobId:target.id };
    resumed.push({
      destination, scope:target.scope, wakeId:activation.wake.wakeId,
      evidenceTrust:activation.trust.evidence, receiptId,
    });
    receipts.add(receiptId);
    return { runtimeReceiptId:receiptId };
  },
});

function activation(id,kind,wakeId){
  return {
    activationVersion:'2',
    wake:{
      wakeId,status:'queued',runtimeReceiptId:null,
      matchedAt:'2026-10-27T00:00:00.000Z',
    },
    target:{runtime:'example-host',kind,id},
    trigger:{
      triggerId:'example-trigger',version:'1',description:null,
      pattern:{
        version:'2',root:{kind:'event',ref:'event_1'},
        partitionBy:[],
        selection:{
          overlap:'disallow',afterMatch:'skipPastLast',maxMatchesPerEvent:10,
        },
        execution:{
          maxCandidates:512,maxSemanticEvaluations:16,maxBufferedEvents:10000,
        },
      },
      lifecycle:{oneShot:true,cooldownMs:0,completeOnGoal:false},
    },
    continuation:{
      instruction:'Continue the host-owned work.',
      contextPolicy:{evidence:'matched_events',maxEvents:20,includeData:true},
    },
    match:{
      matchId:'match-example',status:'matched',partitionKey:null,
      openedAt:'2026-10-27T00:00:00.000Z',
      updatedAt:'2026-10-27T00:00:00.000Z',
    },
    evidence:[],
    trust:{
      continuation:'configured_trigger_instruction',
      evidence:'untrusted_external_signal',
    },
  };
}

const scenarios=[
  activation('agent-one','agent-task','wake-shared'),
  activation('graph-two','graph-checkpoint','wake-shared'),
  activation('job-three','batch-job','wake-standalone'),
];
for(const a of scenarios){
  const result=await dispatch({wake_id:a.wake.wakeId},a);
  assert.equal(result.duplicate,undefined);
  const replay=await dispatch({wake_id:a.wake.wakeId},a);
  assert.equal(replay.duplicate,true);
  assert.equal(replay.runtimeReceiptId,result.runtimeReceiptId);
}
assert.deepEqual(resumed.map(x=>x.destination.type),[
  'agent-task','graph-checkpoint','batch-job',
]);
assert.equal(resumed.length,3);
assert.equal(new Set(resumed.map(x=>x.receiptId)).size,3);
assert.deepEqual(resumed.map(x=>x.scope),[
  'tenant-a','tenant-b','tenant-a',
]);
assert.ok(resumed.every(x=>x.evidenceTrust==='untrusted_external_signal'));
targets.get('graph-two').active=false;
await assert.rejects(dispatch(
  {wake_id:'wake-after-revoke'},
  activation('graph-two','graph-checkpoint','wake-after-revoke'),
),e=>e?.code==='HOST_TARGET_REVOKED');
await assert.rejects(dispatch(
  {wake_id:'wake-wrong-kind'},
  activation('agent-one','graph-checkpoint','wake-wrong-kind'),
),e=>e?.code==='HOST_TARGET_REVOKED');
assert.equal(resumed.length,3,'revoked/wrong-kind targets must not enqueue');
console.log(JSON.stringify({
  schema:'event-intelligence.packed-multi-target-host.v1',
  status:'pass',targetKinds:resumed.map(x=>x.destination.type),
  scopes:new Set(resumed.map(x=>x.scope)).size,
  resumed:resumed.length,replaysDeduplicated:3,
  deniedTargets:2,independentThirdPartyHost:false,
  durableHostReceiptsProven:false,
}));
