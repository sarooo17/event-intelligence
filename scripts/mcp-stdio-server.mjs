import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { describeTriggerLanguage } from '../dist/src/intelligenceProtocol/index.js';
import {
  simulateTrigger,
} from './lib/trigger-inspector.mjs';
import {
  createLocalEventIntelligenceRuntime,
} from './lib/local-event-intelligence-runtime.mjs';
import { createOwnerReadGuard } from './lib/mcp-owner-read-guard.mjs';
import { OPERATION_MANIFEST } from './lib/operation-manifest.mjs';
import { MCP_OPERATION_SCHEMAS } from './lib/mcp-operation-schemas.mjs';
import { OPERATION_OUTPUT_CONTRACTS, validateOperationOutput } from './lib/operation-output-contracts.mjs';

function jsonResult(value, operation) {
  if (operation) validateOperationOutput('stdio', operation, value);
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

function registerReadTools(server, runtime, env) {
  const ownerGuard = createOwnerReadGuard({
    triggerControl: runtime.triggerControl,
    store: runtime.store,
    owner: ownerFromEnv(env),
  });
  server.registerTool(
    OPERATION_MANIFEST.sources.name,
    {
      description:
        'List active event sources currently available to Event Intelligence.',
      inputSchema: MCP_OPERATION_SCHEMAS.sources,
      outputSchema: OPERATION_OUTPUT_CONTRACTS.sources.stdio,
    },
    async ({ connectionIds }) => {
      try {
        return jsonResult({
          sources: await runtime.triggerControl.listEventSources({
            ...(connectionIds ? { connectionIds } : {}),
          }),
        }, 'sources');
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    OPERATION_MANIFEST.languageDescribe.name,
    {
      description:
        'Describe the public Event Intelligence trigger authoring language. Use this when you need to discover supported predicates, composition, temporal, correlation, timing, or lifecycle operators before planning a trigger.',
      inputSchema: MCP_OPERATION_SCHEMAS.languageDescribe,
    },
    async (input) => {
      try {
        return jsonResult(describeTriggerLanguage(input));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    OPERATION_MANIFEST.plan.name,
    {
      description:
        'Compile an agent-friendly trigger plan into a validated durable trigger definition using the event sources currently available. This does not mutate state and does not call another model.',
      inputSchema: MCP_OPERATION_SCHEMAS.plan,
      outputSchema: OPERATION_OUTPUT_CONTRACTS.plan.stdio,
    },
    async (input) => {
      try {
        return jsonResult(await runtime.triggerPlanner.plan(input), 'plan');
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    OPERATION_MANIFEST.list.name,
    {
      description:
        'List durable triggers and lifecycle state for the configured owner only.',
      inputSchema: MCP_OPERATION_SCHEMAS.list,
      outputSchema: OPERATION_OUTPUT_CONTRACTS.list.stdio,
    },
    async () => {
      try {
        return jsonResult({
          triggers: await runtime.triggerControl.listTriggers({
            owner: ownerFromEnv(env),
          }),
        }, 'list');
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    OPERATION_MANIFEST.inspect.name,
    {
      description:
        'Explain a trigger deterministically, including missing clauses, temporal state, deadlines, lineage, derived outputs and wake receipt.',
      inputSchema: MCP_OPERATION_SCHEMAS.inspect,
    },
    async (input) => {
      try {
        const owned = await ownerGuard.assertTrigger(input.triggerId, input.version);
        return jsonResult(await runtime.triggerInspector.inspect({
          ...input,
          // Never let Inspector select a newer, foreign-owned version when
          // the caller omits the version. The authorization is version-bound.
          version: owned.definition.version,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    OPERATION_MANIFEST.simulate.name,
    {
      description:
        'Run a trigger definition against an isolated event sequence without mutating live state.',
      inputSchema: MCP_OPERATION_SCHEMAS.simulate,
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
    OPERATION_MANIFEST.derivedContracts.name,
    {
      description:
        'List versioned derived-event contracts, canonical schemas, fingerprints and registered producers.',
      inputSchema: MCP_OPERATION_SCHEMAS.derivedContracts,
    },
    async ({ eventName }) => {
      try {
        return jsonResult({
          contracts: await runtime.store.listDerivedContracts(eventName),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    OPERATION_MANIFEST.wakeHydrate.name,
    {
      description:
        'Hydrate a composite wake into an Activation Envelope containing the configured continuation and matched event evidence. Evidence data is included only according to the trigger context policy.',
      inputSchema: MCP_OPERATION_SCHEMAS.wakeHydrate,
    },
    async ({ wakeId }) => {
      try {
        await ownerGuard.assertWake(wakeId);
        return jsonResult(await runtime.activationHydrator.hydrateWake(wakeId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    OPERATION_MANIFEST.runtimeStatus.name,
    {
      description:
        'Return local Event Intelligence runtime status, restored counts, host-managed MCP event connections and pending temporal deadlines.',
      inputSchema: MCP_OPERATION_SCHEMAS.runtimeStatus,
    },
    async () => {
      try {
        return jsonResult({
          restored: runtime.restored,
          hostMcpEventConnections: await runtime.mcpEventsClient.status(),
          pendingTemporalDeadlines:
            (await runtime.store.listTemporalDeadlines({ status: 'pending' })).length,
          derivedEvents: (await runtime.store.listDerivedEvents()).length,
          derivedContracts: (await runtime.store.listDerivedContracts()).length,
          writeEnabled: env.MCP_WRITE_ENABLED === 'true',
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

function registerWriteTools(server, runtime, env) {
  const actor = () => actorFromEnv(env);
  const owner = () => ownerFromEnv(env);

  server.registerTool(
    OPERATION_MANIFEST.create.name,
    {
      description:
        'Create a durable trigger. Persistent MCP mutations require explicit confirmationId and MCP_WRITE_ENABLED=true.',
      inputSchema: MCP_OPERATION_SCHEMAS.create,
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

  server.registerTool(
    OPERATION_MANIFEST.pause.name,
    {
      description: 'Pause a durable trigger after explicit confirmation.',
      inputSchema: MCP_OPERATION_SCHEMAS.pause,
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
    OPERATION_MANIFEST.resume.name,
    {
      description: 'Resume a paused durable trigger after explicit confirmation.',
      inputSchema: MCP_OPERATION_SCHEMAS.resume,
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
    OPERATION_MANIFEST.delete.name,
    {
      description: 'Delete a durable trigger after explicit confirmation.',
      inputSchema: MCP_OPERATION_SCHEMAS.delete,
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
    OPERATION_MANIFEST.update.name,
    {
      description:
        'Create a new immutable version of an existing durable trigger after explicit confirmation.',
      inputSchema: MCP_OPERATION_SCHEMAS.update,
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
      version: '0.5.0',
    },
    {
      instructions:
        'Use Event Intelligence to discover event sources and the trigger authoring language, plan/inspect/simulate durable trigger programs, and govern continuations. Prefer event_sources_list plus trigger_language_describe when needed, then author through trigger_plan instead of raw canonical definitions. Persistent mutations are unavailable unless the operator enables MCP_WRITE_ENABLED=true, and each mutation requires confirmationId.',
    },
  );

  registerReadTools(server, runtime, env);
  if (env.MCP_WRITE_ENABLED === 'true') {
    registerWriteTools(server, runtime, env);
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
