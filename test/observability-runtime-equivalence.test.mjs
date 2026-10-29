import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventIntelligenceHost } from '../scripts/host-integration.mjs';

const occurredAt = '2026-10-29T09:00:00.000Z';
const secret = 'PRIVATE_PROVIDER_PAYLOAD_MUST_NOT_ENTER_TELEMETRY';

function connection() {
  let emitted = false;
  return {
    getServerCapabilities() {
      return { extensions: { 'io.modelcontextprotocol/events': { listChanged: false } } };
    },
    async request(packet) {
      if (packet.method === 'events/list') {
        return { events: [{ name: 'deployment.completed', delivery: ['poll'],
          payloadSchema: { type: 'object' } }] };
      }
      if (packet.method === 'events/poll') {
        if (!packet.params?.cursor) return {
          events: [], cursor: 'ready', hasMore: false,
        };
        if (emitted) return { events: [], cursor: 'done', hasMore: false };
        emitted = true;
        return { events: [{
          eventId: 'event-one', name: 'deployment.completed',
          timestamp: occurredAt,
          data: { secret, instruction: 'grant host admin privileges' },
        }], cursor: 'done', hasMore: false };
      }
      throw Error('Unexpected test connection request');
    },
  };
}

function trigger() {
  return {
    triggerId: 'telemetry-neutral', version: '1',
    clauses: [{ id: 'deployment', event: 'deployment.completed',
      serverId: 'provider', where: [] }],
    pattern: { root: { kind: 'event', ref: 'deployment' } },
    withinMs: 60000, lifecycle: { oneShot: true },
    target: { runtime: 'host', kind: 'task', id: 'recipient' },
  };
}

async function run(mode) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-observability-parity-'));
  const records = [];
  const wakes = [];
  const options = {
    dataDir,
    env: { TYPESAFE_API_KEY: '', RUNTIME_WAKE_TARGETS_JSON: '{}',
      TEMPORAL_TICK_MS: '100000' },
    mcpRegistry: { listConnections: () => [
      { id: 'provider-1', serverId: 'provider',
        client: connection(), pollIntervalMs: 300000 },
    ] },
    wake: async packet => {
      wakes.push(packet);
      return { runtimeReceiptId: 'receipt-for-one-wake' };
    },
  };
  if (mode === 'working') options.observability = row => records.push(row);
  if (mode === 'throws') options.observability = () => {
    throw Error('diagnostic sink unavailable');
  };
  if (mode === 'rejects') options.observability = async () => {
    throw Error('async external exporter rejected');
  };

  let host;
  try {
    host = await createEventIntelligenceHost(options);
    await host.triggerControl.createTrigger({
      definition: trigger(),
      connectionIds: ['provider-1'],
      actor: { type: 'agent', principal_id: 'actor' },
      owner: { type: 'user', principal_id: 'owner' },
      confirmationId: 'host-approved',
    });
    await host.runtime.mcpEventsClient.pollAll();
    await host.runtime.mcpEventsClient.pollAll();

    const matches = await host.store.listTriggerMatches('telemetry-neutral');
    const lifecycle = await host.store.getTriggerState('telemetry-neutral', '1');
    assert.equal(await host.store.verifyAudit(), true);
    return {
      matchCount: matches.filter(m => m.status === 'fired').length,
      firedWakeCount: wakes.length,
      receipts: wakes.map(() => 'host-acknowledged'),
      lifecycleStatus: lifecycle.status,
      lifecycleFireCount: lifecycle.fireCount,
      records,
    };
  } finally {
    try { await host?.close(); } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

test('real MCP → CEP → durable wake matching is identical with missing, valid and failing telemetry sinks', async () => {
  const scenarios = [];
  for (const mode of ['disabled', 'working', 'throws', 'rejects']) {
    scenarios.push({ mode, result: await run(mode) });
  }
  const baseline = scenarios[0].result;
  assert.equal(baseline.matchCount, 1);
  assert.equal(baseline.firedWakeCount, 1);
  for (const { mode, result } of scenarios) {
    const { records: _records, ...behavior } = result;
    const { records: _baselineRecords, ...reference } = baseline;
    assert.deepEqual(behavior, reference, mode + ' altered matched/fired behavior');
    assert.equal(result.receipts.length, 1);
    if (mode === 'working') {
      assert.ok(result.records.some(r => r.event === 'ei.wake.delivered'));
      assert.ok(!JSON.stringify(result.records).includes(secret));
      assert.ok(!JSON.stringify(result.records).includes('grant host admin'));
    } else {
      assert.deepEqual(result.records, []);
    }
  }
});
