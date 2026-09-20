import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import {
  parseCompositeTriggerDefinition,
} from '../dist/src/intelligenceProtocol/index.js';
import {
  simulateTrigger,
} from './lib/trigger-inspector.mjs';
import {
  createLocalEventIntelligenceRuntime,
} from './lib/local-event-intelligence-runtime.mjs';

function jsonResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'EVENT_INTELLIGENCE_ERROR';
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: message, code }, null, 2),
      },
    ],
    structuredContent: { error: message, code },
  };
}

function actorFromEnv(env) {
  return {
    type: 'agent',
    principal_id: env.MCP_ACTOR_ID ?? 'mcp-agent',
    ...(env.MCP_TENANT_ID ? { tenant_id: env.MCP_TENANT_ID } : {}),
  };
}

function ownerFromEnv(env) {
  return {
    type: 'user',
    principal_id: env.MCP_OWNER_ID ?? 'local-user',
    ...(env.MCP_TENANT_ID ? { tenant_id: env.MCP_TENANT_ID } : {}),
  };
}

const predicateInputSchema = z.object({
  path: z.string().min(1),
  op: z.enum(['eq', 'neq', 'contains', 'in', 'exists', 'gt', 'gte', 'lt', 'lte']),
  value: z.unknown().optional(),
});

const triggerPlanInputSchema = z.object({
  triggerId: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  description: z.string().max(500).optional(),
  events: z.array(z.object({
    id: z.string().min(1).optional(),
    event: z.string().min(1),
    serverId: z.string().min(1).optional(),
    where: z.array(predicateInputSchema).optional(),
  })).min(1),
  match: z.union([
    z.enum(['all', 'any', 'sequence']),
    z.object({
      kind: z.literal('count'),
      eventId: z.string().min(1),
      atLeast: z.number().int().min(1),
    }),
  ]).optional(),
  withinMs: z.number().int().positive().optional(),
  lifecycle: z.object({
    oneShot: z.boolean().optional(),
    maxFirings: z.number().int().min(1).optional(),
    cooldownMs: z.number().int().nonnegative().optional(),
    expiresAt: z.string().optional(),
    leaseUntil: z.string().optional(),
    completeOnGoal: z.boolean().optional(),
  }).optional(),
  target: z.object({
    runtime: z.string().min(1),
    kind: z.enum(['goal', 'session', 'conversation', 'task', 'spawn_template']),
    id: z.string().min(1),
  }),
  continuation: z.object({
    instruction: z.string().min(1).max(4000),
    contextPolicy: z.object({
      evidence: z.enum(['matched_events', 'refs_only']).optional(),
      maxEvents: z.number().int().min(1).max(50).optional(),
      includeData: z.boolean().optional(),
    }).optional(),
  }),
  correlateBy: z.array(z.object({
    eventId: z.string().min(1),
    path: z.string().min(1),
  })).min(2).optional(),
  semanticCorrelation: z.record(z.string(), z.unknown()).optional(),
});

function registerReadTools(server, runtime) {
  server.registerTool(
    'event_sources_list',
    {
      description:
        'List active event sources currently available to Event Intelligence.',
      inputSchema: z.object({
        connectionIds: z.array(z.string()).optional(),
      }),
    },
    async ({ connectionIds }) => {
      try {
        return jsonResult({
          sources: runtime.triggerControl.listEventSources({
            ...(connectionIds ? { connectionIds } : {}),
          }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'trigger_plan',
    {
      description:
        'Compile an agent-friendly trigger plan into a validated durable trigger definition using the event sources currently available. This does not mutate state and does not call another model.',
      inputSchema: triggerPlanInputSchema,
    },
    async (input) => {
      try {
        return jsonResult(await runtime.triggerPlanner.plan(input));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'trigger_list',
    {
      description:
        'List durable triggers and lifecycle state, optionally scoped to the configured owner.',
      inputSchema: z.object({
        ownerOnly: z.boolean().default(true),
      }),
    },
    async ({ ownerOnly }) => {
      try {
        return jsonResult({
          triggers: runtime.triggerControl.listTriggers(
            ownerOnly ? { owner: ownerFromEnv(process.env) } : {},
          ),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'trigger_inspect',
    {
      description:
        'Explain a trigger deterministically, including missing clauses, temporal state, deadlines, lineage, derived outputs and wake receipt.',
      inputSchema: z.object({
        triggerId: z.string().min(1),
        version: z.string().min(1).optional(),
        matchId: z.string().min(1).optional(),
      }),
    },
    async (input) => {
      try {
        return jsonResult(runtime.triggerInspector.inspect(input));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'trigger_simulate',
    {
      description:
        'Run a trigger definition against an isolated event sequence without mutating live state.',
      inputSchema: z.object({
        definition: z.record(z.string(), z.unknown()),
        events: z.array(z.record(z.string(), z.unknown())),
        until: z.string().optional(),
        order: z.enum(['provided', 'event_time']).default('provided'),
      }),
    },
    async (input) => {
      try {
        return jsonResult(await simulateTrigger(input));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'derived_contracts_list',
    {
      description:
        'List versioned derived-event contracts, canonical schemas, fingerprints and registered producers.',
      inputSchema: z.object({
        eventName: z.string().min(1).optional(),
      }),
    },
    async ({ eventName }) => {
      try {
        return jsonResult({
          contracts: runtime.store.listDerivedContracts(eventName),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'wake_hydrate',
    {
      description:
        'Hydrate a composite wake into an Activation Envelope containing the configured continuation and matched event evidence. Evidence data is included only according to the trigger context policy.',
      inputSchema: z.object({
        wakeId: z.string().min(1),
      }),
    },
    async ({ wakeId }) => {
      try {
        return jsonResult(runtime.activationHydrator.hydrateWake(wakeId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'runtime_status',
    {
      description:
        'Return local Event Intelligence runtime status, restored counts, host-managed MCP event connections and pending temporal deadlines.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return jsonResult({
          restored: runtime.restored,
          hostMcpEventConnections: runtime.mcpEventsClient.status(),
          pendingTemporalDeadlines:
            runtime.store.listTemporalDeadlines({ status: 'pending' }).length,
          derivedEvents: runtime.store.listDerivedEvents().length,
          derivedContracts: runtime.store.listDerivedContracts().length,
          writeEnabled: process.env.MCP_WRITE_ENABLED === 'true',
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

function registerWriteTools(server, runtime) {
  const actor = () => actorFromEnv(process.env);
  const owner = () => ownerFromEnv(process.env);

  server.registerTool(
    'trigger_create',
    {
      description:
        'Create a durable trigger. Persistent MCP mutations require explicit confirmationId and MCP_WRITE_ENABLED=true.',
      inputSchema: z.object({
        definition: z.record(z.string(), z.unknown()).optional(),
        plan: triggerPlanInputSchema.optional(),
        connectionIds: z.array(z.string()).min(1).optional(),
        confirmationId: z.string().min(1),
      }),
    },
    async ({ definition, plan, connectionIds, confirmationId }) => {
      try {
        if ((definition ? 1 : 0) + (plan ? 1 : 0) !== 1) {
          const error = new Error('trigger_create requires exactly one of definition or plan');
          error.code = 'TRIGGER_CREATE_INPUT_INVALID';
          throw error;
        }

        let resolvedDefinition = definition;
        let resolvedConnectionIds = connectionIds;
        let planning = null;
        if (plan) {
          planning = await runtime.triggerPlanner.plan(plan);
          resolvedDefinition = planning.definition;
          resolvedConnectionIds = planning.connectionIds;
        }
        if (!Array.isArray(resolvedConnectionIds) || resolvedConnectionIds.length === 0) {
          const error = new Error('connectionIds are required when trigger_create uses a raw definition');
          error.code = 'TRIGGER_CONNECTION_REQUIRED';
          throw error;
        }

        const receipt = await runtime.triggerControl.createTrigger({
          definition: resolvedDefinition,
          connectionIds: resolvedConnectionIds,
          actor: actor(),
          owner: owner(),
          confirmationId,
        });
        return jsonResult({
          ...receipt,
          ...(planning ? { planning } : {}),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const lifecycleSchema = z.object({
    triggerId: z.string().min(1),
    version: z.string().min(1),
    confirmationId: z.string().min(1),
  });

  server.registerTool(
    'trigger_pause',
    {
      description: 'Pause a durable trigger after explicit confirmation.',
      inputSchema: lifecycleSchema,
    },
    async ({ triggerId, version, confirmationId }) => {
      try {
        return jsonResult(
          await runtime.triggerControl.pauseTrigger({
            triggerId,
            version,
            actor: actor(),
            owner: owner(),
            confirmationId,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'trigger_resume',
    {
      description: 'Resume a paused durable trigger after explicit confirmation.',
      inputSchema: lifecycleSchema,
    },
    async ({ triggerId, version, confirmationId }) => {
      try {
        return jsonResult(
          await runtime.triggerControl.resumeTrigger({
            triggerId,
            version,
            actor: actor(),
            owner: owner(),
            confirmationId,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'trigger_delete',
    {
      description: 'Delete a durable trigger after explicit confirmation.',
      inputSchema: lifecycleSchema,
    },
    async ({ triggerId, version, confirmationId }) => {
      try {
        return jsonResult(
          await runtime.triggerControl.deleteTrigger({
            triggerId,
            version,
            actor: actor(),
            owner: owner(),
            confirmationId,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'trigger_update',
    {
      description:
        'Create a new immutable version of an existing durable trigger after explicit confirmation.',
      inputSchema: z.object({
        triggerId: z.string().min(1),
        expectedVersion: z.string().min(1),
        definition: z.record(z.string(), z.unknown()),
        connectionIds: z.array(z.string()).optional(),
        confirmationId: z.string().min(1),
      }),
    },
    async ({
      triggerId,
      expectedVersion,
      definition,
      connectionIds,
      confirmationId,
    }) => {
      try {
        return jsonResult(
          await runtime.triggerControl.updateTrigger({
            triggerId,
            expectedVersion,
            definition,
            connectionIds,
            actor: actor(),
            owner: owner(),
            confirmationId,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

export async function buildEventIntelligenceMcpServer({
  env = process.env,
} = {}) {
  const runtime = await createLocalEventIntelligenceRuntime({ env });
  const server = new McpServer(
    {
      name: 'mcp-event-intelligence',
      version: '0.3.0',
    },
    {
      instructions:
        'Use Event Intelligence to discover event sources, inspect/simulate durable trigger programs, and govern continuations. The agent authors structured trigger definitions using the discovered source schemas. Persistent mutations are unavailable unless the operator enables MCP_WRITE_ENABLED=true, and each mutation requires confirmationId.',
    },
  );

  registerReadTools(server, runtime);
  if (env.MCP_WRITE_ENABLED === 'true') {
    registerWriteTools(server, runtime);
  }

  return { server, runtime };
}

export async function serveEventIntelligenceStdio({
  env = process.env,
} = {}) {
  const { server, runtime } = await buildEventIntelligenceMcpServer({ env });
  const close = async () => {
    await runtime.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);

  console.error(
    JSON.stringify({
      message: 'mcp_event_intelligence_stdio_ready',
      dataDir: env.DATA_DIR ?? './data',
      writeEnabled: env.MCP_WRITE_ENABLED === 'true',
      mcpProtocolTarget: '2026-07-28',
    }),
  );

  await serveStdio(() => server, { legacy: 'reject' });
}
