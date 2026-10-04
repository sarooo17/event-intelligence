import { z } from 'zod';
import {
  RuntimeTargetSchema,
  parseActivationEnvelope,
} from '../dist/src/intelligenceProtocol/index.js';
import {
  createEventIntelligenceHost,
  createMcpRegistryAdapter,
} from './host-integration.mjs';

const DEFAULT_TOOL_NAMES = Object.freeze({
  sources: 'event_sources_list',
  create: 'trigger_create',
});

const TriggerClauseInput = z.object({
  id: z.string().min(1).max(200).optional(),
  event: z.string().min(1).max(200),
  serverId: z.string().min(1).max(200).optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  where: z.array(z.record(z.string(), z.unknown())).max(32).optional(),
}).strict();

const TriggerCreateInput = z.object({
  trigger_id: z.string().min(1).max(200).optional(),
  version: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  events: z.array(TriggerClauseInput).min(1).max(32),
  pattern: z.record(z.string(), z.unknown()).optional(),
  within_ms: z.number().int().positive().max(30 * 24 * 60 * 60 * 1000)
    .optional(),
  event_time: z.object({
    allowed_lateness_ms: z.number().int().nonnegative()
      .max(30 * 24 * 60 * 60 * 1000),
  }).strict().optional(),
  instruction: z.string().min(1).max(4000),
  one_shot: z.boolean().optional(),
  max_firings: z.number().int().min(1).optional(),
  cooldown_ms: z.number().int().nonnegative().optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
  lease_until: z.string().datetime({ offset: true }).optional(),
  complete_on_goal: z.boolean().optional(),
}).strict();

const SOURCES_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {},
});

const CREATE_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['events', 'instruction'],
  properties: {
    trigger_id: { type: 'string', minLength: 1, maxLength: 200 },
    version: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: 'string', maxLength: 500 },
    events: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['event'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 200 },
          event: { type: 'string', minLength: 1, maxLength: 200 },
          serverId: { type: 'string', minLength: 1, maxLength: 200 },
          arguments: { type: 'object', additionalProperties: true },
          where: {
            type: 'array',
            maxItems: 32,
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    pattern: { type: 'object', additionalProperties: true },
    within_ms: {
      type: 'integer',
      minimum: 1,
      maximum: 30 * 24 * 60 * 60 * 1000,
    },
    event_time: {
      type: 'object',
      additionalProperties: false,
      required: ['allowed_lateness_ms'],
      properties: {
        allowed_lateness_ms: {
          type: 'integer',
          minimum: 0,
          maximum: 30 * 24 * 60 * 60 * 1000,
        },
      },
    },
    instruction: { type: 'string', minLength: 1, maxLength: 4000 },
    one_shot: { type: 'boolean' },
    max_firings: { type: 'integer', minimum: 1 },
    cooldown_ms: { type: 'integer', minimum: 0 },
    expires_at: { type: 'string' },
    lease_until: { type: 'string' },
    complete_on_goal: { type: 'boolean' },
  },
});

function errorCode(error, fallback) {
  return String(error?.code || fallback);
}

function fail(error, fallbackCode = 'EVENT_INTELLIGENCE_TOOL_FAILED') {
  return {
    ok: false,
    error: {
      code: errorCode(error, fallbackCode),
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function normalizeIdentity(input, label) {
  if (!input || typeof input !== 'object') {
    throw new Error(`${label} is required`);
  }
  const type = String(input.type || '').trim();
  const principalId = String(
    input.principal_id ?? input.principalId ?? '',
  ).trim();
  const tenantId = String(
    input.tenant_id ?? input.tenantId ?? '',
  ).trim();
  if (!type || !principalId) {
    throw new Error(`${label} requires type and principal_id`);
  }
  return {
    type,
    principal_id: principalId,
    ...(tenantId ? { tenant_id: tenantId } : {}),
  };
}

function normalizeAuthorization(decision) {
  if (decision === true) return { allowed: true };
  if (decision === false || decision == null) return { allowed: false };
  if (typeof decision !== 'object') {
    throw new Error('authorize() must return boolean or an authorization decision');
  }
  return {
    ...decision,
    allowed: decision.allowed === true,
  };
}

function normalizedReceipt(result, fallbackId) {
  if (typeof result === 'string' && result.trim()) {
    return { runtimeReceiptId: result };
  }
  if (
    result &&
    typeof result === 'object' &&
    typeof result.runtimeReceiptId === 'string' &&
    result.runtimeReceiptId.trim()
  ) {
    return result;
  }
  if (result === undefined && fallbackId) {
    return { runtimeReceiptId: fallbackId };
  }
  throw new Error('Activation delivery must return runtimeReceiptId');
}

function wakeIdFromPacket(packet) {
  if (!packet || typeof packet !== 'object') return null;
  const value = packet.wake_id ?? packet.wakeId;
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * A runtime-neutral continuation target. EI persists and returns this value
 * without assigning semantics to runtime/kind/id.
 */
export function createContinuationTarget(input) {
  return RuntimeTargetSchema.parse(input);
}

/**
 * Runtime-neutral wake boundary.
 *
 * EI owns wake retries; the host owns target resolution and the side effect
 * that resumes work. Optional receipt hooks close the host-side crash window
 * without teaching EI what a Turn, Execution, thread, graph or Case is.
 */
export function createActivationDispatcher({
  resolveTarget,
  hasReceipt,
  receiptId,
  deliver,
} = {}) {
  if (resolveTarget !== undefined && typeof resolveTarget !== 'function') {
    throw new Error('resolveTarget must be a function');
  }
  if (hasReceipt !== undefined && typeof hasReceipt !== 'function') {
    throw new Error('hasReceipt must be a function');
  }
  if (receiptId !== undefined && typeof receiptId !== 'function') {
    throw new Error('receiptId must be a function');
  }
  if (typeof deliver !== 'function') {
    throw new Error('Activation dispatcher requires deliver()');
  }

  return async (packet = {}, activationInput) => {
    const activation = parseActivationEnvelope(activationInput);
    const packetWakeId = wakeIdFromPacket(packet);
    if (packetWakeId && packetWakeId !== activation.wake.wakeId) {
      const error = new Error(
        `Wake id mismatch: packet ${packetWakeId} != activation ${activation.wake.wakeId}`,
      );
      error.code = 'EVENT_ACTIVATION_WAKE_ID_MISMATCH';
      throw error;
    }

    const candidateReceiptId = String(
      await (receiptId
        ? receiptId({ packet, activation })
        : activation.wake.wakeId),
    ).trim();
    if (!candidateReceiptId) {
      const error = new Error('Activation receipt id must be non-empty');
      error.code = 'EVENT_ACTIVATION_RECEIPT_ID_REQUIRED';
      throw error;
    }

    if (hasReceipt && await hasReceipt(candidateReceiptId, activation)) {
      return {
        runtimeReceiptId: candidateReceiptId,
        duplicate: true,
      };
    }

    const target = resolveTarget
      ? await resolveTarget(activation.target, activation)
      : activation.target;
    if (target == null) {
      const error = new Error(
        `Continuation target unavailable: ${activation.target.runtime}/${activation.target.kind}/${activation.target.id}`,
      );
      error.code = 'EVENT_ACTIVATION_TARGET_UNAVAILABLE';
      throw error;
    }

    try {
      return normalizedReceipt(
        await deliver({
          packet,
          activation,
          target,
          receiptId: candidateReceiptId,
        }),
        candidateReceiptId,
      );
    } catch (error) {
      if (hasReceipt && await hasReceipt(candidateReceiptId, activation)) {
        return {
          runtimeReceiptId: candidateReceiptId,
          duplicate: true,
        };
      }
      throw error;
    }
  };
}

async function scopedHostFor(host, resolvedContext) {
  if (
    resolvedContext?.scopeId !== undefined &&
    typeof host.scope === 'function'
  ) {
    return host.scope(resolvedContext.scopeId);
  }
  return host;
}

function sourceSummary(source) {
  return {
    connectionId: source.connectionId,
    serverId: source.serverId,
    eventName: source.eventName,
    description: source.description ?? null,
    delivery: source.delivery ?? [],
    inputSchema: source.inputSchema ?? {},
    payloadSchema: source.payloadSchema ?? {},
  };
}

function buildPlanInput(parsed, target) {
  return {
    ...(parsed.trigger_id ? { triggerId: parsed.trigger_id } : {}),
    ...(parsed.version ? { version: parsed.version } : {}),
    ...(parsed.description ? { description: parsed.description } : {}),
    events: parsed.events.map((event) => ({
      ...(event.id ? { id: event.id } : {}),
      event: event.event,
      ...(event.serverId ? { serverId: event.serverId } : {}),
      arguments: event.arguments ?? {},
      where: event.where ?? [],
    })),
    ...(parsed.pattern ? { pattern: parsed.pattern } : {}),
    ...(parsed.within_ms !== undefined ? { withinMs: parsed.within_ms } : {}),
    ...(parsed.event_time
      ? { eventTime: { allowedLatenessMs: parsed.event_time.allowed_lateness_ms } }
      : {}),
    lifecycle: {
      oneShot: parsed.one_shot ?? true,
      ...(parsed.max_firings !== undefined
        ? { maxFirings: parsed.max_firings }
        : {}),
      ...(parsed.cooldown_ms !== undefined
        ? { cooldownMs: parsed.cooldown_ms }
        : {}),
      ...(parsed.expires_at ? { expiresAt: parsed.expires_at } : {}),
      ...(parsed.lease_until ? { leaseUntil: parsed.lease_until } : {}),
      ...(parsed.complete_on_goal !== undefined
        ? { completeOnGoal: parsed.complete_on_goal }
        : {}),
    },
    target,
    continuation: {
      instruction: parsed.instruction,
      contextPolicy: {
        evidence: 'matched_events',
        maxEvents: 20,
        includeData: true,
      },
    },
  };
}

/**
 * Portable agent-facing tools. The descriptors do not depend on OpenAI,
 * Anthropic, MCP tool objects, Muffin, Artemis, LangGraph, or any other host.
 * Adapters only need to translate {name, description, inputSchema, execute}.
 */
export function createEventIntelligenceAgentTools({
  host,
  resolveContext,
  authorize,
  names = {},
} = {}) {
  if (!host || typeof host !== 'object') {
    throw new Error('Agent tools require an Event Intelligence host');
  }
  if (typeof resolveContext !== 'function') {
    throw new Error('Agent tools require resolveContext()');
  }
  if (typeof authorize !== 'function') {
    throw new Error('Agent tools require authorize() for durable mutations');
  }

  const toolNames = {
    ...DEFAULT_TOOL_NAMES,
    ...names,
  };

  return [
    {
      name: toolNames.sources,
      description:
        'List live future-event sources discovered from MCP connections already owned by the host runtime. Use this before creating a trigger so event names and schemas are not guessed.',
      inputSchema: SOURCES_INPUT_SCHEMA,
      async execute(_args, runtimeContext) {
        try {
          const resolved = await resolveContext(runtimeContext, {
            action: 'event.sources.list',
          });
          if (typeof host.refreshMcpRegistry === 'function') {
            await host.refreshMcpRegistry();
          }
          const scoped = await scopedHostFor(host, resolved);
          const sources = await Promise.resolve(scoped.eventSources);
          return {
            ok: true,
            data: {
              sources: Array.isArray(sources)
                ? sources.map(sourceSummary)
                : [],
            },
          };
        } catch (error) {
          return fail(error, 'EVENT_SOURCES_LIST_FAILED');
        }
      },
    },
    {
      name: toolNames.create,
      description:
        'Create a durable future condition. The host, not the model, supplies the continuation target and authority context; Event Intelligence wakes that target only when the condition matches.',
      inputSchema: CREATE_INPUT_SCHEMA,
      async execute(args, runtimeContext) {
        const parsed = TriggerCreateInput.safeParse(args ?? {});
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return {
            ok: false,
            error: {
              code: 'EVENT_TRIGGER_INPUT_INVALID',
              message:
                `${issue?.path?.join('.') || 'input'} — ${issue?.message || 'invalid'}`,
            },
          };
        }

        try {
          const resolved = await resolveContext(runtimeContext, {
            action: 'trigger.create',
            input: parsed.data,
          });
          const target = createContinuationTarget(resolved?.target);
          if (typeof host.refreshMcpRegistry === 'function') {
            await host.refreshMcpRegistry();
          }
          const scoped = await scopedHostFor(host, resolved);
          const plan = await scoped.planTrigger(
            buildPlanInput(parsed.data, target),
          );

          const decision = normalizeAuthorization(
            await authorize({
              action: 'trigger.create',
              runtimeContext,
              context: resolved,
              input: parsed.data,
              plan,
            }),
          );
          if (!decision.allowed) {
            return {
              ok: false,
              error: {
                code: String(
                  decision.code || 'EVENT_TRIGGER_AUTHORIZATION_DENIED',
                ),
                message: String(
                  decision.message || 'Host denied durable trigger creation',
                ),
              },
            };
          }

          const actor = normalizeIdentity(
            decision.actor ?? resolved?.actor,
            'actor',
          );
          const owner = normalizeIdentity(
            decision.owner ?? resolved?.owner,
            'owner',
          );
          const confirmationId = String(
            decision.confirmationId ?? resolved?.confirmationId ?? '',
          ).trim();

          const created = await scoped.triggerControl.createTrigger({
            definition: plan.definition,
            connectionIds: plan.connectionIds,
            actor,
            owner,
            ...(confirmationId ? { confirmationId } : {}),
          });

          return {
            ok: true,
            data: {
              receiptId: created.receiptId,
              triggerId: created.definition?.triggerId,
              version: created.definition?.version,
              state: created.state,
              connectionIds: plan.connectionIds,
              warnings: plan.warnings ?? [],
            },
          };
        } catch (error) {
          return fail(error, 'EVENT_TRIGGER_CREATE_FAILED');
        }
      },
    },
  ];
}

/**
 * High-level embedded install. EI remains in-process; MCP transports/auth and
 * continuation semantics remain owned by the host.
 */
export async function createEmbeddedEventIntelligence({
  dataDir,
  store,
  env = {},
  mcpRegistry,
  mcp,
  mcpClients = [],
  semanticEvaluator,
  activation,
  wake,
  wakeHandlers = {},
  agentTools,
  createHost = createEventIntelligenceHost,
} = {}) {
  if (activation !== undefined && wake !== undefined) {
    throw new Error('Provide activation or wake, not both');
  }

  let registry = mcpRegistry;
  if (!registry && mcp) {
    registry = createMcpRegistryAdapter({
      listConnections: mcp.listConnections,
      ...(mcp.subscribe ? { subscribe: mcp.subscribe } : {}),
    });
  }

  const wakeHandler = activation
    ? createActivationDispatcher(activation)
    : wake;

  const host = await createHost({
    dataDir,
    store,
    env,
    mcpRegistry: registry,
    mcpClients,
    semanticEvaluator,
    ...(wakeHandler ? { wake: wakeHandler } : {}),
    wakeHandlers,
  });

  const tools = agentTools
    ? createEventIntelligenceAgentTools({
        host,
        ...agentTools,
      })
    : [];

  return {
    host,
    runtime: host.runtime,
    tools,
    createAgentTools(options) {
      return createEventIntelligenceAgentTools({
        host,
        ...options,
      });
    },
    refresh() {
      return host.refreshMcpRegistry();
    },
    status() {
      return host.mcpStatus();
    },
    scope(scopeId) {
      return host.scope(scopeId);
    },
    close() {
      return host.close();
    },
  };
}

export const PORTABLE_EVENT_INTELLIGENCE_TOOL_NAMES = DEFAULT_TOOL_NAMES;
