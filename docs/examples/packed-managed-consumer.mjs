#!/usr/bin/env node
// A locally authored, independently installed npm consumer (not a third-party
// developer). All EI imports resolve from the packed package, never the repo.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventIntelligence } from 'mcp-event-intelligence/embedded';

const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-packed-managed-'));
const env = {
  TYPESAFE_API_KEY: '',
  RUNTIME_WAKE_TARGETS_JSON: '{}',
  TEMPORAL_TICK_MS: '100000',
  WAKE_RETRY_TICK_MS: '100000',
};
const owner = { type: 'user', principal_id: 'external-owner' };
const actor = { type: 'agent', principal_id: 'external-agent' };
const target = { runtime: 'consumer-host', kind: 'task', id: 'durable-1' };
const hostReceipts = new Set();
const deliveries = [];
let denyAction = 'trigger.create';
let grants = 0;
const policyRequests = [];
let starts = 0;
let integration;

const requiredHostCapabilities = [
  'mcp.registry','storage.durable','wake.receipts','tooling.owner-scoped',
];
const options = {
  hostContract: { version:'1', required:requiredHostCapabilities },
  dataDir: dir, env,
  mcp: { list: () => [] },
  runtime: {
    receiptNamespace: 'packed-consumer',
    hasReceipt: id => hostReceipts.has(id),
    resolveContext: () => ({ target, owner, actor }),
    control: ({ action, capability, context }) => {
      assert.equal(capability.id, 'event-intelligence.' + action);
      assert.deepEqual(context.actor, actor,
        'host policy must receive the full actor identity, including type');
      assert.deepEqual(context.owner, owner,
        'host policy must receive the full owner identity, including type');
      assert.deepEqual(context.target, target);
      policyRequests.push({ action, decision: denyAction === action ? 'return' : 'execute' });
      if (denyAction === action) return {
        action: 'return',
        result: { ok: false, error: { code: 'HOST_APPROVAL_REQUIRED' } },
      };
      grants++;
      return {
        action: 'execute',
        execution: { receiptId: 'host-approved:' + action + ':' + grants },
      };
    },
    deliver: ({ activation, receiptId }) => {
      if (hostReceipts.has(receiptId)) {
        return { runtimeReceiptId: receiptId, duplicate: true };
      }
      hostReceipts.add(receiptId);
      deliveries.push({
        triggerId: activation.trigger.triggerId,
        wakeId: activation.wake.wakeId,
        receiptId,
      });
      return { runtimeReceiptId: receiptId };
    },
  },
};

const call = async (name, input = {}) => {
  const tool = integration.toolCatalog.get(name);
  assert.ok(tool, 'missing packed host tool: ' + name);
  const result = await tool.execute(input, {});
  assert.equal(result.ok, true, name + ': ' + JSON.stringify(result.error));
  return result.data;
};

const event = async (id, value) => integration.host.runtime.compositeEventConsumer
  .ingestCorrelatable({
    traceId: 'packed-managed:' + id,
    sourceEventId: id,
    name: 'consumer.order.changed',
    serverId: 'consumer-source',
    provider: 'consumer-test',
    occurredAt: new Date().toISOString(),
    data: { value },
  });

// Every mutation denial must leave both the trigger definitions and durable
// lifecycle states unchanged, not merely avoid sending an external wake.
const assertDeniedMutation = async (action, tool, args) => {
  const before = JSON.stringify([
    await integration.host.store.listTriggers(),
    await integration.host.store.listTriggerStates(),
  ]);
  denyAction = action;
  const result = await integration.toolCatalog.get(tool).execute(args, {});
  assert.equal(result.ok, false, action);
  assert.equal(result.error.code, 'HOST_APPROVAL_REQUIRED');
  assert.equal(JSON.stringify([
    await integration.host.store.listTriggers(),
    await integration.host.store.listTriggerStates(),
  ]), before, 'denied mutation wrote durable trigger or lifecycle state');
  denyAction = null;
};

const input = (threshold, extra = {}) => ({
  events: [{
    id: 'order',
    event: 'consumer.order.changed',
    serverId: 'consumer-source',
    where: [{ path: 'value', op: 'gt', value: threshold }],
  }],
  instruction: 'Resume after a high-value order.',
  one_shot: false,
  max_firings: 4,
  ...extra,
});

async function start() {
  integration = await createEventIntelligence(options);
  starts++;
  assert.equal(integration.hostContract.schema,'event-intelligence.host-contract.v1');
  assert.equal(integration.hostContract.version,'1');
  assert.equal(integration.hostContract.readiness,'configuration-validated');
  assert.deepEqual(integration.hostContract.required,requiredHostCapabilities);
  for (const id of requiredHostCapabilities) {
    assert.equal(integration.hostContract.available[id],true,id);
  }
  assert.equal(Object.isFrozen(integration.hostContract.available),true);
  assert.equal(integration.toolCatalog.all.length, 8);
}

try {
  // A malformed/insufficient requirement must be rejected by the packed
  // public facade BEFORE creating a live host, MCP connection or store.
  let rejectedHostStarts=0;
  await assert.rejects(createEventIntelligence({
    hostContract:{ version:'1',required:['wake.receipts'] },
    runtime:{ deliver:()=>({runtimeReceiptId:'unreached'}) },
    createHost:async()=>{
      rejectedHostStarts++;
      throw new Error('invalid HostContract unexpectedly started EI');
    },
  }),error=>error?.code==='EI_HOST_CAPABILITY_UNAVAILABLE');
  assert.equal(rejectedHostStarts,0,
    'packed HostContract must fail before host startup side effects');

  await start();
  await integration.host.triggerControl.registerEventSource({
    sourceId: 'consumer:order',
    connectionId: 'consumer-connection',
    serverId: 'consumer-source',
    eventName: 'consumer.order.changed',
    delivery: ['poll'],
    payloadSchema: {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'number' } },
    },
    enabled: true,
  }, { type: 'system', principal_id: 'consumer-registration' });

  // Apply the exact same definition + lifecycle state check to creation,
  // not just the existing pause/resume/update/delete denial probes.
  await assertDeniedMutation('trigger.create', 'trigger_create',
    input(1000, { trigger_id: 'consumer-trigger' }));
  assert.deepEqual(await integration.host.store.listTriggers(), [],
    'host approval/interrupt response must precede durable mutation');

  const created = await call('trigger_create', input(1000, {
    trigger_id: 'consumer-trigger',
  }));
  assert.equal(created.triggerId, 'consumer-trigger');
  assert.equal(created.version, '1');
  const listed = await call('trigger_list', {});
  assert.equal(listed.total, 1);
  assert.equal(listed.triggers[0].triggerId, 'consumer-trigger');
  await assertDeniedMutation('trigger.pause', 'trigger_pause', {
    trigger_id: 'consumer-trigger',
  });
  const paused = await call('trigger_pause', { trigger_id: 'consumer-trigger' });
  assert.equal(paused.state.status, 'paused');
  await event('paused', 1500);
  assert.equal(deliveries.length, 0);
  await assertDeniedMutation('trigger.resume', 'trigger_resume', {
    trigger_id: 'consumer-trigger',
  });
  const resumed = await call('trigger_resume', { trigger_id: 'consumer-trigger' });
  assert.equal(resumed.state.status, 'active');
  await event('first-wake', 1500);
  assert.equal(deliveries.length, 1);
  const receipt = await integration.host.store.getWakeDelivery(deliveries[0].wakeId);
  assert.equal(receipt.status, 'delivered');
  assert.equal(receipt.runtimeReceiptId, deliveries[0].receiptId);

  const originalDelivery = { ...deliveries[0] };
  await integration.close();
  integration = null;
  await start();

  const persisted = await call('trigger_list', { trigger_id: 'consumer-trigger' });
  assert.equal(persisted.total, 1);
  // This read intentionally uses the NEW EI instance, not the old one.
  const reopenedReceipt = structuredClone(
    await integration.host.store.getWakeDelivery(originalDelivery.wakeId));
  assert.equal(reopenedReceipt?.status, 'delivered',
    'fresh store must hydrate a durable wake receipt');
  assert.equal(reopenedReceipt?.runtimeReceiptId, originalDelivery.receiptId);
  const beforeReplayState = JSON.stringify(
    await integration.host.store.listTriggerStates());
  const beforeReplayMatches = JSON.stringify(
    await integration.host.store.listTriggerMatches('consumer-trigger'));
  await event('first-wake', 1500);
  assert.equal(deliveries.length, 1, 'durable source replay cannot redeliver wake');
  assert.equal(JSON.stringify(await integration.host.store.listTriggerStates()),
    beforeReplayState, 'replay cannot increase durable fireCount');
  assert.equal(JSON.stringify(await integration.host.store.listTriggerMatches('consumer-trigger')),
    beforeReplayMatches, 'replay cannot append a duplicate logical match');
  assert.deepEqual(await integration.host.store.getWakeDelivery(originalDelivery.wakeId),
    reopenedReceipt, 'replay cannot rewrite the original persisted receipt');

  await assertDeniedMutation('trigger.update', 'trigger_update', input(2000, {
    trigger_id: 'consumer-trigger', expected_version: '1', version: '2',
  }));
  const updated = await call('trigger_update', input(2000, {
    trigger_id: 'consumer-trigger', expected_version: '1', version: '2',
  }));
  assert.equal(updated.previousVersion, '1');
  assert.equal(updated.version, '2');
  await event('no-longer-matches', 1700);
  assert.equal(deliveries.length, 1);
  await event('second-wake', 2100);
  assert.equal(deliveries.length, 2);

  await assertDeniedMutation('trigger.delete', 'trigger_delete', {
    trigger_id: 'consumer-trigger', version: '2',
  });
  const deleted = await call('trigger_delete', {
    trigger_id: 'consumer-trigger', version: '2',
  });
  assert.equal(deleted.state.status, 'deleted');
  await event('deleted-no-wake', 2500);
  assert.equal(deliveries.length, 2);

  for (const action of [
    'trigger.create', 'trigger.pause', 'trigger.resume',
    'trigger.update', 'trigger.delete',
  ]) {
    assert.deepEqual(policyRequests.filter(item => item.action === action)
      .map(item => item.decision), ['return', 'execute'],
    'missing per-action deny/execute authorization proof: ' + action);
  }

  console.log(JSON.stringify({
    schema: 'event-intelligence.packed-managed-consumer.v1',
    status: 'pass',
    hostContractVersion:'1',
    hostRequiredCapabilities:requiredHostCapabilities.length,
    hostContractRejectedBeforeStart:true,
    approvalDeniedBeforeWrite: true,
    policyActionsVerified: policyRequests.length,
    reopenedReceiptVerified: true,
    durableReplayStateUnchanged: true,
    management: ['create', 'list', 'pause', 'resume', 'update', 'delete'],
    starts,
    deliveries: deliveries.length,
    replayRedeliveries: 0,
    independentThirdPartyHost: false,
  }));
} finally {
  try { await integration?.close(); } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
