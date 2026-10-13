// Locally authored test-only host. The parent controls registry snapshots
// through IPC; no EI in-memory object survives a SIGKILL + fresh fork.
import { createEventIntelligenceHost } from '../scripts/host-integration.mjs';

const dataDir = process.env.EI_REGISTRY_PROCESS_TEST_DIR;
if (!dataDir) throw new Error('EI_REGISTRY_PROCESS_TEST_DIR is required');

const owner = { type: 'user', principal_id: 'registry-conformance-owner' };
const connectionId = 'registry-connection';
const serverId = 'registry-provider';
const eventName = 'registry.changed';

let entries = [];
let queued = [];
let pollIndex = 0;
const wakes = [];

function provider(session) {
  return {
    getServerCapabilities() {
      return {
        extensions: { 'io.modelcontextprotocol/events': { listChanged: false } },
      };
    },
    async request(message) {
      if (message.method === 'events/list') {
        return {
          events: [{
            name: eventName,
            delivery: ['poll'],
            payloadSchema: {
              type: 'object',
              properties: { value: { type: 'number' } },
              required: ['value'],
              additionalProperties: false,
            },
          }],
        };
      }
      if (message.method === 'events/poll') {
        const events = queued.splice(0);
        return { events, cursor: session + ':' + ++pollIndex, hasMore: false };
      }
      throw new Error('Unexpected Events method: ' + message.method);
    },
  };
}

const host = await createEventIntelligenceHost({
  dataDir,
  env: {
    TYPESAFE_API_KEY: '',
    RUNTIME_WAKE_TARGETS_JSON: '{}',
    TEMPORAL_TICK_MS: '100000',
    WAKE_RETRY_TICK_MS: '100000',
  },
  mcpRegistry: { listConnections: () => entries },
  wake: async (packet, activation) => {
    const runtimeReceiptId = 'registry-host-receipt:' + packet.wake_id;
    wakes.push({
      triggerId: activation.trigger.triggerId,
      wakeId: packet.wake_id,
      runtimeReceiptId,
    });
    return { runtimeReceiptId };
  },
});

const handlers = {
  async registry({ connected, session }) {
    entries = connected ? [{
      id: connectionId,
      serverId,
      client: provider(String(session)),
      pollIntervalMs: 300000,
    }] : [];
    return host.refreshMcpRegistry();
  },
  async attachExplicit() {
    const result = await host.attachMcpClient({
      id: connectionId,
      serverId,
      client: provider('explicit-host'),
      pollIntervalMs: 300000,
    });
    return { connectionId: result.connectionId };
  },
  async create() {
    const plan = await host.planTrigger({
      triggerId: 'registry-durable-trigger',
      events: [{ id: 'changed', serverId, event: eventName }],
      lifecycle: { oneShot: false, maxFirings: 3 },
      target: {
        runtime: 'independent-host-shape',
        kind: 'task',
        id: 'durable-task',
      },
      continuation: { instruction: 'Continue after registry change.' },
    });
    const result = await host.triggerControl.createTrigger({
      definition: plan.definition,
      connectionIds: plan.connectionIds,
      actor: owner,
      owner,
    });
    return { id: result.definition.triggerId, connections: plan.connectionIds };
  },
  async enqueue({ id, value }) {
    queued.push({
      eventId: id,
      name: eventName,
      timestamp: '2026-10-13T10:00:00.000Z',
      data: { value },
    });
    return queued.length;
  },
  async poll() {
    return host.runtime.mcpEventsClient.pollAll();
  },
  async snapshot({ wakeIds = [] } = {}) {
    const [status, sources, storedSources, triggers, receipts] = await Promise.all([
      host.mcpStatus(),
      host.eventSources,
      host.store.listEventSources(),
      host.triggerControl.listTriggers({ owner }),
      Promise.all(wakeIds.map(id => host.store.getWakeDelivery(id))),
    ]);
    return {
      pid: process.pid,
      connections: status.map(entry => ({
        id: entry.connectionId, serverId: entry.serverId,
        scopeId: entry.scopeId,
      })),
      sources: sources.map(src => ({
        eventName: src.eventName, enabled: src.enabled,
        connectionId: src.connectionId,
      })),
      storedSources: storedSources.map(src => ({
        eventName: src.eventName, enabled: src.enabled,
        connectionId: src.connectionId,
      })),
      triggers: triggers.map(entry => ({
        id: entry.definition.triggerId,
        version: entry.definition.version,
        status: entry.state.status,
        fireCount: entry.state.fireCount,
      })),
      receipts: receipts.map((entry, i) => ({
        wakeId: wakeIds[i],
        status: entry?.status ?? null,
        runtimeReceiptId: entry?.runtimeReceiptId ?? null,
      })),
      wakes: [...wakes],
    };
  },
};

let queue = Promise.resolve();
process.on('message', message => {
  if (!Number.isSafeInteger(message?.id) ||
      !Object.hasOwn(handlers, message?.method)) return;
  queue = queue.then(async () => {
    try {
      const result = await handlers[message.method](message.args ?? {});
      process.send?.({ type: 'reply', id: message.id, result });
    } catch (error) {
      process.send?.({
        type: 'reply',
        id: message.id,
        error: {
          code: typeof error?.code === 'string'
            ? error.code : 'REGISTRY_TEST_WORKER_ERROR',
          message: 'registry fixture operation failed',
        },
      });
    }
  });
});

process.send?.({ type: 'ready', pid: process.pid });
