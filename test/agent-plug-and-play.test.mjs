import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEventIntelligenceHost } from '../scripts/host-integration.mjs';

test('agent-friendly plan compiles, fires, and delivers a hydrated activation envelope', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-agent-pnp-'));
  const deliveries = [];

  const host = await createEventIntelligenceHost({
    dataDir,
    env: {
      TYPESAFE_API_KEY: '',
      RUNTIME_WAKE_TARGETS_JSON: '{}',
      TEMPORAL_TICK_MS: '100000',
      WAKE_RETRY_TICK_MS: '100000',
    },
    wake: async (packet, activation) => {
      deliveries.push({ packet, activation });
      return { runtimeReceiptId: `agent:${packet.wake_id}` };
    },
  });

  try {
    await host.triggerControl.registerEventSource({
      sourceId: 'erp:invoice-submitted',
      connectionId: 'erp-connection',
      serverId: 'erpnext',
      eventName: 'erpnext.sales_invoice.submitted',
      delivery: ['poll'],
      payloadSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'grand_total', 'customer'],
        properties: {
          name: { type: 'string' },
          grand_total: { type: 'number' },
          customer: { type: 'string' },
        },
      },
      enabled: true,
    }, {
      type: 'system',
      principal_id: 'test-source',
    });

    const planned = await host.planTrigger({
      description: 'Large submitted invoice review',
      events: [{
        id: 'invoice',
        event: 'erpnext.sales_invoice.submitted',
        where: [{
          path: 'grand_total',
          op: 'gt',
          value: 10000,
        }],
      }],
      match: 'all',
      withinMs: 3600000,
      lifecycle: { oneShot: false },
      target: {
        runtime: 'agent',
        kind: 'conversation',
        id: 'chat-42',
      },
      continuation: {
        instruction: 'Check the submitted invoice for anomalies and report back in this conversation.',
      },
    });

    assert.equal(planned.planVersion, '1');
    assert.deepEqual(planned.connectionIds, ['erp-connection']);
    assert.equal(planned.definition.clauses[0].serverId, 'erpnext');
    assert.deepEqual(planned.definition.expression, {
      kind: 'anyOf',
      refs: ['invoice'],
    });
    assert.equal(
      planned.definition.continuation.instruction,
      'Check the submitted invoice for anomalies and report back in this conversation.',
    );
    assert.deepEqual(planned.definition.continuation.contextPolicy, {
      evidence: 'matched_events',
      maxEvents: 50,
      includeData: true,
    });

    await host.triggerControl.createTrigger({
      definition: planned.definition,
      connectionIds: planned.connectionIds,
      actor: { type: 'user', principal_id: 'user-1' },
      owner: { type: 'user', principal_id: 'user-1' },
    });

    const belowThreshold = await host.runtime.compositeEventConsumer.ingestCorrelatable({
      traceId: 'trace-low',
      sourceEventId: 'invoice-low',
      name: 'erpnext.sales_invoice.submitted',
      serverId: 'erpnext',
      provider: 'erp',
      occurredAt: '2026-09-20T16:00:00.000Z',
      data: {
        name: 'SINV-LOW',
        grand_total: 9000,
        customer: 'Small Co',
      },
    });
    assert.equal(belowThreshold.deliveries.length, 0);
    assert.equal(deliveries.length, 0);

    const matched = await host.runtime.compositeEventConsumer.ingestCorrelatable({
      traceId: 'trace-high',
      sourceEventId: 'invoice-high',
      name: 'erpnext.sales_invoice.submitted',
      serverId: 'erpnext',
      provider: 'erp',
      occurredAt: '2026-09-20T16:01:00.000Z',
      data: {
        name: 'SINV-HIGH',
        grand_total: 12500,
        customer: 'Acme',
      },
    });

    assert.equal(matched.deliveries[0].status, 'wake_delivered');
    assert.equal(deliveries.length, 1);

    const { packet, activation } = deliveries[0];
    assert.equal(packet.target.id, 'chat-42');
    assert.equal(packet.source_event_refs[0].event_id, 'invoice-high');
    assert.equal('data' in packet.source_event_refs[0], false);

    assert.equal(activation.activationVersion, '1');
    assert.equal(
      activation.continuation.instruction,
      'Check the submitted invoice for anomalies and report back in this conversation.',
    );
    assert.equal(activation.trust.evidence, 'untrusted_external_signal');
    assert.deepEqual(activation.evidence[0].data, {
      name: 'SINV-HIGH',
      grand_total: 12500,
      customer: 'Acme',
    });

    const hydrated = host.hydrateWake(packet.wake_id);
    assert.equal(hydrated.wake.status, 'delivered');
    assert.equal(hydrated.wake.runtimeReceiptId, `agent:${packet.wake_id}`);
    assert.deepEqual(hydrated.evidence[0].data, activation.evidence[0].data);
  } finally {
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('activation context policy can keep hydrated evidence reference-only', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-agent-pnp-refs-'));
  let captured = null;

  const host = await createEventIntelligenceHost({
    dataDir,
    env: {
      TYPESAFE_API_KEY: '',
      RUNTIME_WAKE_TARGETS_JSON: '{}',
      TEMPORAL_TICK_MS: '100000',
      WAKE_RETRY_TICK_MS: '100000',
    },
    wake: async (packet, activation) => {
      captured = { packet, activation };
      return { runtimeReceiptId: `agent:${packet.wake_id}` };
    },
  });

  try {
    await host.triggerControl.registerEventSource({
      sourceId: 'mail:received',
      connectionId: 'mail-connection',
      serverId: 'mail',
      eventName: 'email.received',
      payloadSchema: {
        type: 'object',
        properties: {
          sender: { type: 'string' },
          subject: { type: 'string' },
        },
      },
    }, { type: 'system', principal_id: 'test-source' });

    const planned = await host.planTrigger({
      events: [{ event: 'email.received' }],
      target: { runtime: 'agent', kind: 'task', id: 'mail-review' },
      continuation: {
        instruction: 'Review the new email.',
        contextPolicy: {
          evidence: 'refs_only',
          maxEvents: 10,
          includeData: false,
        },
      },
    });

    await host.triggerControl.createTrigger({
      definition: planned.definition,
      connectionIds: planned.connectionIds,
      actor: { type: 'user', principal_id: 'user-1' },
      owner: { type: 'user', principal_id: 'user-1' },
    });

    await host.runtime.compositeEventConsumer.ingestCorrelatable({
      traceId: 'mail-trace',
      sourceEventId: 'mail-1',
      name: 'email.received',
      serverId: 'mail',
      occurredAt: '2026-09-20T17:00:00.000Z',
      data: { sender: 'pippo@example.com', subject: 'Private' },
    });

    assert.ok(captured);
    assert.equal('data' in captured.activation.evidence[0], false);
  } finally {
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
