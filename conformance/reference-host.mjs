import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventIntelligenceHost } from '../scripts/host-integration.mjs';
import { runHostConformance } from '../scripts/host-conformance.mjs';

export const referenceHostAdapter = {
  name: 'event-intelligence-reference-host',

  async createHarness({ observability }) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-host-conformance-'));
    const externalDeliveries = [];
    const owner = { type: 'user', principal_id: 'host-conformance-user' };
    let host = null;

    const start = async () => {
      host = await createEventIntelligenceHost({
        dataDir,
        observability,
        env: {
          TYPESAFE_API_KEY: '',
          RUNTIME_WAKE_TARGETS_JSON: '{}',
          TEMPORAL_TICK_MS: '100000',
          WAKE_RETRY_TICK_MS: '100000',
        },
        wake: async (packet, activation) => {
          const runtimeReceiptId = `conformance:${packet.wake_id}`;
          externalDeliveries.push({
            triggerId: activation.trigger.triggerId,
            wakeId: packet.wake_id,
            runtimeReceiptId,
          });
          return { runtimeReceiptId };
        },
      });
    };

    await start();

    await host.triggerControl.registerEventSource({
      sourceId: 'conformance:value-changed',
      connectionId: 'conformance-connection',
      serverId: 'conformance',
      eventName: 'conformance.value.changed',
      delivery: ['poll'],
      payloadSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: {
          value: { type: 'number' },
          secretProbe: { type: 'string' },
        },
      },
      enabled: true,
    }, {
      type: 'system',
      principal_id: 'host-conformance',
    });

    return {
      async createTrigger({
        triggerId,
        threshold,
        oneShot,
        maxFirings,
      }) {
        const planned = await host.planTrigger({
          triggerId,
          events: [{
            id: 'value',
            event: 'conformance.value.changed',
            serverId: 'conformance',
            where: [{
              path: 'value',
              op: 'gt',
              value: threshold,
            }],
          }],
          lifecycle: {
            oneShot,
            ...(maxFirings === undefined ? {} : { maxFirings }),
          },
          target: {
            runtime: 'conformance-host',
            kind: 'task',
            id: triggerId,
          },
          continuation: {
            instruction: 'Continue the isolated Event Intelligence conformance scenario.',
          },
        });

        await host.triggerControl.createTrigger({
          definition: planned.definition,
          connectionIds: planned.connectionIds,
          actor: owner,
          owner,
        });
      },

      async emitEvent({ eventId, value, secretProbe }) {
        await host.runtime.compositeEventConsumer.ingestCorrelatable({
          traceId: `conformance:${eventId}`,
          sourceEventId: eventId,
          name: 'conformance.value.changed',
          serverId: 'conformance',
          provider: 'conformance',
          occurredAt: new Date().toISOString(),
          data: {
            value,
            ...(secretProbe ? { secretProbe } : {}),
          },
        });
      },

      deliveries() {
        return [...externalDeliveries];
      },

      async restart() {
        await host.close();
        await start();
      },

      async listTriggers() {
        const rows = await host.triggerControl.listTriggers({ owner });
        return rows.map((entry) => ({
          triggerId: entry.definition.triggerId,
          version: entry.definition.version,
          status: entry.state.status,
          fireCount: entry.state.fireCount,
        }));
      },

      async inspectTrigger(triggerId) {
        const rows = (await host.triggerControl.listTriggers({ owner }))
          .filter((candidate) => candidate.definition.triggerId === triggerId);
        const current = rows.filter((candidate) =>
          ['active', 'paused'].includes(candidate.state.status)
        ).at(-1) ?? rows.at(-1);
        return current
          ? {
              ...current.state,
              version: current.definition.version,
            }
          : null;
      },

      async pauseTrigger(triggerId) {
        const rows = (await host.triggerControl.listTriggers({ owner }))
          .filter((candidate) =>
            candidate.definition.triggerId === triggerId &&
            candidate.state.status === 'active'
          );
        const current = rows.at(-1);
        if (!current) throw new Error(`No active trigger ${triggerId}`);
        await host.triggerControl.pauseTrigger({
          triggerId,
          version: current.definition.version,
          actor: owner,
          owner,
        });
      },

      async resumeTrigger(triggerId) {
        const rows = (await host.triggerControl.listTriggers({ owner }))
          .filter((candidate) =>
            candidate.definition.triggerId === triggerId &&
            candidate.state.status === 'paused'
          );
        const current = rows.at(-1);
        if (!current) throw new Error(`No paused trigger ${triggerId}`);
        await host.triggerControl.resumeTrigger({
          triggerId,
          version: current.definition.version,
          actor: owner,
          owner,
        });
      },

      async updateTrigger({ triggerId, threshold }) {
        const rows = (await host.triggerControl.listTriggers({ owner }))
          .filter((candidate) =>
            candidate.definition.triggerId === triggerId &&
            ['active', 'paused'].includes(candidate.state.status)
          );
        const current = rows.at(-1);
        if (!current) throw new Error(`No mutable trigger ${triggerId}`);
        const currentVersion = String(current.definition.version);
        const nextVersion = /^\d+$/.test(currentVersion)
          ? String(Number(currentVersion) + 1)
          : `${currentVersion}-r2`;
        const planned = await host.planTrigger({
          triggerId,
          version: nextVersion,
          events: [{
            id: 'value',
            event: 'conformance.value.changed',
            serverId: 'conformance',
            where: [{
              path: 'value',
              op: 'gt',
              value: threshold,
            }],
          }],
          lifecycle: {
            oneShot: current.definition.lifecycle?.oneShot ?? false,
            ...(current.definition.lifecycle?.maxFirings === undefined
              ? {}
              : { maxFirings: current.definition.lifecycle.maxFirings }),
          },
          target: current.definition.target,
          continuation: current.definition.continuation,
        });
        await host.triggerControl.updateTrigger({
          triggerId,
          expectedVersion: current.definition.version,
          definition: planned.definition,
          connectionIds: planned.connectionIds,
          actor: owner,
          owner,
        });
      },

      async deleteTrigger(triggerId) {
        const rows = (await host.triggerControl.listTriggers({ owner }))
          .filter((candidate) =>
            candidate.definition.triggerId === triggerId &&
            ['active', 'paused'].includes(candidate.state.status)
          );
        const current = rows.at(-1);
        if (!current) throw new Error(`No current trigger ${triggerId}`);
        await host.triggerControl.deleteTrigger({
          triggerId,
          version: current.definition.version,
          actor: owner,
          owner,
        });
      },

      async close() {
        await host?.close();
        await rm(dataDir, { recursive: true, force: true });
      },
    };
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runHostConformance(referenceHostAdapter, {
    profile: 'management',
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
