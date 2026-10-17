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
let allowed = false;
let grants = 0;
let starts = 0;
let integration;

const options = {
  dataDir: dir, env,
  mcp: { list: () => [] },
  runtime: {
    receiptNamespace: 'packed-consumer',
    hasReceipt: id => hostReceipts.has(id),
    resolveContext: () => ({ target, owner, actor }),
    control: ({ action }) => {
      if (!allowed) return {
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
  assert.equal(integration.toolCatalog.all.length, 8);
}

try {
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

  const denied = await integration.toolCatalog.get('trigger_create').execute(
    input(1000, { trigger_id: 'consumer-trigger' }), {},
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'HOST_APPROVAL_REQUIRED');
  assert.deepEqual(await integration.host.store.listTriggers(), [],
    'host approval/interrupt response must precede durable mutation');

  allowed = true;
  const created = await call('trigger_create', input(1000, {
    trigger_id: 'consumer-trigger',
  }));
  assert.equal(created.triggerId, 'consumer-trigger');
  assert.equal(created.version, '1');
  const listed = await call('trigger_list', {});
  assert.equal(listed.total, 1);
  assert.equal(listed.triggers[0].triggerId, 'consumer-trigger');
  const paused = await call('trigger_pause', { trigger_id: 'consumer-trigger' });
  assert.equal(paused.state.status, 'paused');
  await event('paused', 1500);
  assert.equal(deliveries.length, 0);
  const resumed = await call('trigger_resume', { trigger_id: 'consumer-trigger' });
  assert.equal(resumed.state.status, 'active');
  await event('first-wake', 1500);
  assert.equal(deliveries.length, 1);
  const receipt = await integration.host.store.getWakeDelivery(deliveries[0].wakeId);
  assert.equal(receipt.status, 'delivered');
  assert.equal(receipt.runtimeReceiptId, deliveries[0].receiptId);

  await integration.close();
  integration = null;
  await start();

  const persisted = await call('trigger_list', { trigger_id: 'consumer-trigger' });
  assert.equal(persisted.total, 1);
  await event('first-wake', 1500);
  assert.equal(deliveries.length, 1, 'durable source replay cannot redeliver wake');

  const updated = await call('trigger_update', input(2000, {
    trigger_id: 'consumer-trigger', expected_version: '1', version: '2',
  }));
  assert.equal(updated.previousVersion, '1');
  assert.equal(updated.version, '2');
  await event('no-longer-matches', 1700);
  assert.equal(deliveries.length, 1);
  await event('second-wake', 2100);
  assert.equal(deliveries.length, 2);

  const deleted = await call('trigger_delete', {
    trigger_id: 'consumer-trigger', version: '2',
  });
  assert.equal(deleted.state.status, 'deleted');
  await event('deleted-no-wake', 2500);
  assert.equal(deliveries.length, 2);

  console.log(JSON.stringify({
    schema: 'event-intelligence.packed-managed-consumer.v1',
    status: 'pass',
    approvalDeniedBeforeWrite: true,
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
