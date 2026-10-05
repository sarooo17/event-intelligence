import { createHash } from 'node:crypto';
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
  list: 'trigger_list',
  inspect: 'trigger_inspect',
  pause: 'trigger_pause',
  resume: 'trigger_resume',
  delete: 'trigger_delete',
  update: 'trigger_update',
});

export const EVENT_INTELLIGENCE_CAPABILITIES = Object.freeze({
  eventSourcesList: Object.freeze({
    id: 'event-intelligence.event-sources.list',
    operation: 'read',
    resource: 'event-source',
    effect: 'none',
    durability: 'ephemeral',
    hostControl: 'none',
  }),
  triggerCreate: Object.freeze({
    id: 'event-intelligence.trigger.create',
    operation: 'create',
    resource: 'trigger',
    effect: 'durable-state',
    durability: 'durable',
    hostControl: 'required',
  }),
  triggerList: Object.freeze({
    id: 'event-intelligence.trigger.list',
    operation: 'read',
    resource: 'trigger',
    effect: 'none',
    durability: 'ephemeral',
    hostControl: 'none',
  }),
  triggerInspect: Object.freeze({
    id: 'event-intelligence.trigger.inspect',
    operation: 'read',
    resource: 'trigger',
    effect: 'none',
    durability: 'ephemeral',
    hostControl: 'none',
  }),
  triggerPause: Object.freeze({
    id: 'event-intelligence.trigger.pause',
    operation: 'update',
    resource: 'trigger',
    effect: 'durable-state',
    durability: 'durable',
    hostControl: 'required',
  }),
  triggerResume: Object.freeze({
    id: 'event-intelligence.trigger.resume',
    operation: 'update',
    resource: 'trigger',
    effect: 'durable-state',
    durability: 'durable',
    hostControl: 'required',
  }),
  triggerDelete: Object.freeze({
    id: 'event-intelligence.trigger.delete',
    operation: 'delete',
    resource: 'trigger',
    effect: 'durable-state',
    durability: 'durable',
    hostControl: 'required',
  }),
  triggerUpdate: Object.freeze({
    id: 'event-intelligence.trigger.update',
    operation: 'update',
    resource: 'trigger',
    effect: 'durable-state',
    durability: 'durable',
    hostControl: 'required',
  }),
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


const TriggerListInput = z.object({
  status: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(16)]).optional(),
  trigger_id: z.string().min(1).max(200).optional(),
  version: z.string().min(1).max(100).optional(),
  connection_id: z.string().min(1).max(200).optional(),
  event: z.string().min(1).max(200).optional(),
  target_runtime: z.string().min(1).max(200).optional(),
  target_kind: z.string().min(1).max(200).optional(),
  target_id: z.string().min(1).max(500).optional(),
  one_shot: z.boolean().optional(),
  remaining_only: z.boolean().optional(),
  include_definition: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

const TriggerInspectInput = z.object({
  trigger_id: z.string().min(1).max(200),
  version: z.string().min(1).max(100).optional(),
  match_id: z.string().min(1).max(200).optional(),
}).strict();

const TriggerLifecycleInput = z.object({
  trigger_id: z.string().min(1).max(200),
  version: z.string().min(1).max(100).optional(),
}).strict();

const TriggerUpdateInput = TriggerCreateInput.omit({
  trigger_id: true,
  version: true,
}).extend({
  trigger_id: z.string().min(1).max(200),
  expected_version: z.string().min(1).max(100).optional(),
  version: z.string().min(1).max(100).optional(),
}).strict();

const LIST_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      oneOf: [
        { type: 'string', minLength: 1 },
        {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: { type: 'string', minLength: 1 },
        },
      ],
    },
    trigger_id: { type: 'string', minLength: 1, maxLength: 200 },
    version: { type: 'string', minLength: 1, maxLength: 100 },
    connection_id: { type: 'string', minLength: 1, maxLength: 200 },
    event: { type: 'string', minLength: 1, maxLength: 200 },
    target_runtime: { type: 'string', minLength: 1, maxLength: 200 },
    target_kind: { type: 'string', minLength: 1, maxLength: 200 },
    target_id: { type: 'string', minLength: 1, maxLength: 500 },
    one_shot: { type: 'boolean' },
    remaining_only: { type: 'boolean' },
    include_definition: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
});

const INSPECT_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['trigger_id'],
  properties: {
    trigger_id: { type: 'string', minLength: 1, maxLength: 200 },
    version: { type: 'string', minLength: 1, maxLength: 100 },
    match_id: { type: 'string', minLength: 1, maxLength: 200 },
  },
});

const LIFECYCLE_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['trigger_id'],
  properties: {
    trigger_id: { type: 'string', minLength: 1, maxLength: 200 },
    version: { type: 'string', minLength: 1, maxLength: 100 },
  },
});

const UPDATE_INPUT_SCHEMA = Object.freeze({
  ...CREATE_INPUT_SCHEMA,
  required: ['trigger_id', 'events', 'instruction'],
  properties: {
    ...CREATE_INPUT_SCHEMA.properties,
    trigger_id: { type: 'string', minLength: 1, maxLength: 200 },
    expected_version: { type: 'string', minLength: 1, maxLength: 100 },
    version: { type: 'string', minLength: 1, maxLength: 100 },
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

function normalizeLegacyAuthorization(decision) {
  if (decision === true) return { action: 'execute' };
  if (decision === false || decision == null) {
    return {
      action: 'return',
      result: {
        ok: false,
        error: {
          code: 'EVENT_TRIGGER_AUTHORIZATION_DENIED',
          message: 'Host denied durable trigger creation',
        },
      },
    };
  }
  if (typeof decision !== 'object') {
    throw new Error('authorize() must return boolean or an authorization decision');
  }
  if (decision.allowed === true) {
    return {
      action: 'execute',
      execution: {
        actor: decision.actor,
        owner: decision.owner,
        receiptId: decision.confirmationId,
      },
    };
  }
  return {
    action: 'return',
    result: {
      ok: false,
      error: {
        code: String(decision.code || 'EVENT_TRIGGER_AUTHORIZATION_DENIED'),
        message: String(
          decision.message || 'Host denied durable trigger creation',
        ),
      },
    },
  };
}

function normalizeHostControlDecision(decision) {
  if (!decision || typeof decision !== 'object') {
    throw new Error(
      'Host control must return { action: "execute" } or { action: "return", result }',
    );
  }
  if (decision.action === 'return') {
    if (!decision.result || typeof decision.result.ok !== 'boolean') {
      throw new Error('Host control return action requires a portable tool result');
    }
    return decision;
  }
  if (decision.action !== 'execute') {
    throw new Error(
      'Host control action must be "execute" or "return"',
    );
  }
  return {
    action: 'execute',
    execution:
      decision.execution && typeof decision.execution === 'object'
        ? decision.execution
        : {},
  };
}

export function createResultReference(reference) {
  if (reference == null) return undefined;
  if (typeof reference !== 'object') {
    throw new Error('result reference must be an object');
  }
  const id = String(reference.id || '').trim();
  if (!id) throw new Error('result reference id is required');
  return {
    ...reference,
    id,
    ...(reference.kind == null
      ? {}
      : { kind: String(reference.kind).trim() || undefined }),
  };
}

async function projectPortableFailure(projectError, input, canonical) {
  if (typeof projectError !== 'function') return canonical;
  try {
    const projected = await projectError({
      ...input,
      error: canonical.error,
      result: canonical,
    });
    if (projected == null) return canonical;
    if (typeof projected !== 'object' || projected.ok !== false) {
      throw new Error('projectError() must return a PortableToolResult with ok:false');
    }
    return projected;
  } catch {
    return canonical;
  }
}

async function projectPortableResult(projectResult, input) {
  if (typeof projectResult !== 'function') {
    return { ok: true, data: input.value };
  }

  const projected = await projectResult(input);
  if (projected == null) {
    return { ok: true, data: input.value };
  }
  if (typeof projected !== 'object') {
    throw new Error('projectResult() must return an object');
  }

  const reference = createResultReference(projected.reference);
  const hasInline = Object.prototype.hasOwnProperty.call(projected, 'inline');
  if (!hasInline && !reference) {
    throw new Error('projectResult() must return inline and/or reference');
  }

  return {
    ok: true,
    ...(hasInline ? { data: projected.inline } : {}),
    result: {
      ...(hasInline ? { inline: projected.inline } : {}),
      ...(reference ? { reference } : {}),
      ...(projected.summary == null
        ? {}
        : { summary: String(projected.summary) }),
      ...(projected.metadata && typeof projected.metadata === 'object'
        ? { metadata: projected.metadata }
        : {}),
    },
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

export function createDeterministicReceiptId(
  namespace,
  wakeId,
  { length = 32 } = {},
) {
  const normalizedNamespace = String(namespace ?? '').trim();
  const normalizedWakeId = String(wakeId ?? '').trim();
  if (!normalizedNamespace) {
    throw new Error('receipt namespace is required');
  }
  if (!normalizedWakeId) {
    throw new Error('wake id is required');
  }
  if (!Number.isInteger(length) || length < 8 || length > 64) {
    throw new Error('receipt id length must be an integer between 8 and 64');
  }
  return createHash('sha256')
    .update(JSON.stringify([normalizedNamespace, normalizedWakeId]))
    .digest('hex')
    .slice(0, length);
}

/**
 * Runtime-neutral registry over host-owned event connections.
 *
 * Static iterables are accepted directly by createEmbeddedRuntimeIntegration();
 * use this explicit factory when the host has dynamic discovery/subscription.
 */
export function createEventSourceRegistry({
  list,
  subscribe,
} = {}) {
  if (typeof list !== 'function') {
    throw new Error('Event source registry requires list()');
  }
  if (subscribe !== undefined && typeof subscribe !== 'function') {
    throw new Error('Event source registry subscribe must be a function');
  }

  return Object.freeze({
    list,
    ...(subscribe ? { subscribe } : {}),
  });
}

/**
 * Neutral catalog for host tool exposure. It does not decide policy or adapt
 * descriptors to any vendor SDK; the embedding runtime owns both.
 */
export function summarizeEventSourceStatus(
  statuses = [],
  refreshOutcomes = [],
) {
  const rows = Array.isArray(statuses) ? statuses : [];
  const refresh = Array.isArray(refreshOutcomes) ? refreshOutcomes : [];
  const connectionIds = new Set();
  const errorIds = new Set();
  let anonymousErrors = 0;
  let eventsCapable = 0;
  let eventDefinitions = 0;

  for (const outcome of refresh) {
    if (!outcome || typeof outcome !== 'object') continue;
    const id = String(outcome.connectionId ?? '').trim();
    if (outcome.status !== 'detached' && id) connectionIds.add(id);
    if (outcome.status === 'error' || outcome.error != null) {
      if (id) errorIds.add(id);
      else anonymousErrors += 1;
    }
  }

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.connectionId ?? row.id ?? '').trim();
    if (id) connectionIds.add(id);
    if (row.error != null) {
      if (id) errorIds.add(id);
      else anonymousErrors += 1;
      continue;
    }
    if (Array.isArray(row.events) && row.events.length > 0) {
      eventsCapable += 1;
      eventDefinitions += row.events.length;
    }
  }

  return Object.freeze({
    connections: connectionIds.size || rows.length,
    eventsCapable,
    eventDefinitions,
    errors: errorIds.size + anonymousErrors,
    statuses: rows,
    refreshOutcomes: refresh,
  });
}

export function bindEmbeddedRuntimeIntegration(
  integration,
  { adapt, register, onClose } = {},
) {
  if (!integration || typeof integration !== 'object') {
    throw new Error('embedded integration is required');
  }
  if (typeof adapt !== 'function') {
    throw new Error('bind adapt() is required');
  }
  if (typeof register !== 'function') {
    throw new Error('bind register() is required');
  }
  if (onClose !== undefined && typeof onClose !== 'function') {
    throw new Error('bind onClose must be a function');
  }

  const adapted = integration.tools.map((portableTool) => {
    const hostTool = adapt(portableTool);
    register(hostTool, portableTool);
    return hostTool;
  });

  if (onClose) {
    onClose(() => integration.close());
  }

  return Object.freeze(adapted);
}

export function createPortableToolCatalog(tools = []) {
  const all = Object.freeze([...tools]);
  const byName = new Map(all.map((tool) => [tool.name, tool]));

  return Object.freeze({
    all,
    get(name) {
      return byName.get(name) ?? null;
    },
    list({ capabilityIds } = {}) {
      if (!capabilityIds) return [...all];
      const allowed = new Set(capabilityIds);
      return all.filter((tool) => allowed.has(tool.capability?.id));
    },
    capabilities() {
      return all.map((tool) => tool.capability).filter(Boolean);
    },
  });
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
  receiptNamespace,
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
  if (
    receiptNamespace !== undefined &&
    (typeof receiptNamespace !== 'string' || !receiptNamespace.trim())
  ) {
    throw new Error('receiptNamespace must be a non-empty string');
  }
  if (receiptId !== undefined && receiptNamespace !== undefined) {
    throw new Error('Provide receiptId or receiptNamespace, not both');
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
      await (
        receiptId
          ? receiptId({ packet, activation })
          : receiptNamespace
            ? createDeterministicReceiptId(
                receiptNamespace,
                activation.wake.wakeId,
              )
            : activation.wake.wakeId
      ),
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


function compactTriggerEntry(entry, includeDefinition = false) {
  const definition = entry?.definition ?? {};
  const state = entry?.state ?? {};
  const lifecycle = definition.lifecycle ?? {};
  const maxFirings = lifecycle.maxFirings ?? null;
  const fireCount = Number(state.fireCount ?? 0);
  return {
    triggerId: definition.triggerId ?? null,
    version: definition.version ?? null,
    description: definition.description ?? null,
    status: state.status ?? null,
    fireCount,
    maxFirings,
    remainingFirings:
      Number.isFinite(Number(maxFirings))
        ? Math.max(0, Number(maxFirings) - fireCount)
        : null,
    oneShot: Boolean(lifecycle.oneShot),
    connectionIds: Array.isArray(state.connectionIds) ? state.connectionIds : [],
    target: definition.target ?? null,
    events: Array.isArray(definition.clauses)
      ? definition.clauses.map((clause) => ({
          id: clause.id,
          serverId: clause.serverId,
          event: clause.event,
        }))
      : [],
    updatedAt: state.updatedAt ?? null,
    ...(includeDefinition ? { definition } : {}),
  };
}

function filterOwnedTriggerEntries(entries, input = {}) {
  const statuses = input.status == null
    ? null
    : new Set((Array.isArray(input.status) ? input.status : [input.status]).map(String));
  return entries.filter((entry) => {
    const definition = entry?.definition ?? {};
    const state = entry?.state ?? {};
    const lifecycle = definition.lifecycle ?? {};
    const target = definition.target ?? {};
    if (statuses && !statuses.has(String(state.status ?? ''))) return false;
    if (input.trigger_id && definition.triggerId !== input.trigger_id) return false;
    if (input.version && definition.version !== input.version) return false;
    if (
      input.connection_id &&
      !(Array.isArray(state.connectionIds) && state.connectionIds.includes(input.connection_id))
    ) return false;
    if (
      input.event &&
      !(Array.isArray(definition.clauses) && definition.clauses.some(
        (clause) => clause?.event === input.event,
      ))
    ) return false;
    if (input.target_runtime && target.runtime !== input.target_runtime) return false;
    if (input.target_kind && target.kind !== input.target_kind) return false;
    if (input.target_id && target.id !== input.target_id) return false;
    if (
      input.one_shot !== undefined &&
      Boolean(lifecycle.oneShot) !== input.one_shot
    ) return false;
    if (input.remaining_only) {
      if (!['active', 'paused'].includes(String(state.status ?? ''))) return false;
      if (
        lifecycle.maxFirings !== undefined &&
        Number(state.fireCount ?? 0) >= Number(lifecycle.maxFirings)
      ) return false;
    }
    return true;
  });
}

async function ownedTriggerEntries(scoped, resolved) {
  const owner = normalizeIdentity(resolved?.owner, 'owner');
  const entries = await scoped.triggerControl.listTriggers({ owner });
  return { owner, entries: Array.isArray(entries) ? entries : [] };
}

function selectOwnedTrigger(entries, triggerId, version, allowedStatuses) {
  let candidates = entries.filter(
    (entry) => entry?.definition?.triggerId === triggerId,
  );
  if (version) {
    candidates = candidates.filter(
      (entry) => entry?.definition?.version === version,
    );
  }
  if (allowedStatuses?.length) {
    const allowed = new Set(allowedStatuses);
    candidates = candidates.filter(
      (entry) => allowed.has(String(entry?.state?.status ?? '')),
    );
  }
  if (candidates.length === 0) {
    const error = new Error(
      version
        ? `Unknown owned trigger ${triggerId}@${version}`
        : `No current owned trigger found for ${triggerId}`,
    );
    error.code = 'TRIGGER_NOT_FOUND';
    throw error;
  }
  if (!version && candidates.length > 1) {
    const error = new Error(
      `Trigger ${triggerId} has multiple matching versions; specify version`,
    );
    error.code = 'TRIGGER_VERSION_AMBIGUOUS';
    throw error;
  }
  return candidates[0];
}

function nextPortableVersion(entries, triggerId, currentVersion) {
  const used = new Set(
    entries
      .filter((entry) => entry?.definition?.triggerId === triggerId)
      .map((entry) => String(entry?.definition?.version ?? '')),
  );
  if (/^\d+$/.test(currentVersion)) {
    let candidate = String(Number(currentVersion) + 1);
    while (used.has(candidate)) candidate = String(Number(candidate) + 1);
    return candidate;
  }
  let revision = 2;
  let candidate = `${currentVersion}-r${revision}`;
  while (used.has(candidate)) {
    revision += 1;
    candidate = `${currentVersion}-r${revision}`;
  }
  return candidate;
}

/**
 * Portable agent-facing tools. The descriptors are runtime-neutral.
 * The embedding host performs any final translation into its own tool system.
 */
export function createEventIntelligenceAgentTools({
  host,
  resolveContext,
  control,
  projectResult,
  projectError,
  authorize,
  names = {},
} = {}) {
  if (!host || typeof host !== 'object') {
    throw new Error('Agent tools require an Event Intelligence host');
  }
  if (typeof resolveContext !== 'function') {
    throw new Error('Agent tools require resolveContext()');
  }
  if (control !== undefined && typeof control !== 'function') {
    throw new Error('Agent tools control must be a function');
  }
  if (authorize !== undefined && typeof authorize !== 'function') {
    throw new Error('Agent tools authorize must be a function');
  }
  if (!control && !authorize) {
    throw new Error(
      'Durable mutations require a host control() callback',
    );
  }
  if (projectResult !== undefined && typeof projectResult !== 'function') {
    throw new Error('Agent tools projectResult must be a function');
  }
  if (projectError !== undefined && typeof projectError !== 'function') {
    throw new Error('Agent tools projectError must be a function');
  }

  const toolNames = {
    ...DEFAULT_TOOL_NAMES,
    ...names,
  };

  const sourcesCapability =
    EVENT_INTELLIGENCE_CAPABILITIES.eventSourcesList;
  const createCapability =
    EVENT_INTELLIGENCE_CAPABILITIES.triggerCreate;
  const listCapability =
    EVENT_INTELLIGENCE_CAPABILITIES.triggerList;
  const inspectCapability =
    EVENT_INTELLIGENCE_CAPABILITIES.triggerInspect;
  const pauseCapability =
    EVENT_INTELLIGENCE_CAPABILITIES.triggerPause;
  const resumeCapability =
    EVENT_INTELLIGENCE_CAPABILITIES.triggerResume;
  const deleteCapability =
    EVENT_INTELLIGENCE_CAPABILITIES.triggerDelete;
  const updateCapability =
    EVENT_INTELLIGENCE_CAPABILITIES.triggerUpdate;

  return [
    {
      name: toolNames.sources,
      description:
        'List live future-event sources discovered from event connections already owned by the host runtime. Use this before creating a trigger so event names and schemas are not guessed.',
      inputSchema: SOURCES_INPUT_SCHEMA,
      capability: sourcesCapability,
      async execute(_args, runtimeContext) {
        try {
          const resolved = await resolveContext(runtimeContext, {
            action: 'event.sources.list',
            capability: sourcesCapability,
          });
          if (typeof host.refreshMcpRegistry === 'function') {
            await host.refreshMcpRegistry();
          }
          const scoped = await scopedHostFor(host, resolved);
          const sources = await Promise.resolve(scoped.eventSources);
          const value = {
            sources: Array.isArray(sources)
              ? sources.map(sourceSummary)
              : [],
          };
          return await projectPortableResult(projectResult, {
            capability: sourcesCapability,
            runtimeContext,
            context: resolved,
            value,
          });
        } catch (error) {
          const canonical = fail(error, 'EVENT_SOURCES_LIST_FAILED');
          return projectPortableFailure(projectError, {
            capability: sourcesCapability,
            runtimeContext,
            context: undefined,
            phase: 'event.sources.list',
          }, canonical);
        }
      },
    },
    {
      name: toolNames.create,
      description:
        'Create a durable future condition. The host supplies continuation, control and identity context; Event Intelligence wakes the opaque continuation target only when the condition matches.',
      inputSchema: CREATE_INPUT_SCHEMA,
      capability: createCapability,
      async execute(args, runtimeContext) {
        const parsed = TriggerCreateInput.safeParse(args ?? {});
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const canonical = {
            ok: false,
            error: {
              code: 'EVENT_TRIGGER_INPUT_INVALID',
              message:
                `${issue?.path?.join('.') || 'input'} — ${issue?.message || 'invalid'}`,
            },
          };
          return projectPortableFailure(projectError, {
            capability: createCapability,
            runtimeContext,
            context: undefined,
            phase: 'trigger.input',
          }, canonical);
        }

        let resolved;
        let scoped;
        let plan;
        try {
          resolved = await resolveContext(runtimeContext, {
            action: 'trigger.create',
            capability: createCapability,
            input: parsed.data,
          });
          const target = createContinuationTarget(resolved?.target);
          if (typeof host.refreshMcpRegistry === 'function') {
            await host.refreshMcpRegistry();
          }
          scoped = await scopedHostFor(host, resolved);
          plan = await scoped.planTrigger(
            buildPlanInput(parsed.data, target),
          );
        } catch (error) {
          const canonical = fail(error, 'EVENT_TRIGGER_PLAN_FAILED');
          return projectPortableFailure(projectError, {
            capability: createCapability,
            runtimeContext,
            context: resolved,
            phase: 'trigger.plan',
          }, canonical);
        }

        // Host control is intentionally outside EI's error-normalization
        // boundary. A runtime may return an opaque result or throw its native
        // interrupt/suspension signal; EI must not reinterpret that mechanism.
        //
        // The deprecated authorize() path keeps its historical behavior:
        // ordinary callback failures are normalized into PortableToolResult
        // errors instead of becoming rejected tool executions.
        let rawDecision;
        if (control) {
          rawDecision = await control({
            capability: createCapability,
            action: 'trigger.create',
            runtimeContext,
            context: resolved,
            input: parsed.data,
            plan,
          });
        } else {
          try {
            rawDecision = normalizeLegacyAuthorization(
              await authorize({
                action: 'trigger.create',
                runtimeContext,
                context: resolved,
                input: parsed.data,
                plan,
              }),
            );
          } catch (error) {
            const canonical = fail(error, 'EVENT_TRIGGER_CREATE_FAILED');
            return projectPortableFailure(projectError, {
              capability: createCapability,
              runtimeContext,
              context: resolved,
              phase: 'trigger.control',
            }, canonical);
          }
        }
        const decision = normalizeHostControlDecision(rawDecision);

        if (decision.action === 'return') {
          return decision.result;
        }

        let value;
        try {
          const execution = decision.execution ?? {};
          const actor = normalizeIdentity(
            execution.actor ?? resolved?.actor,
            'actor',
          );
          const owner = normalizeIdentity(
            execution.owner ?? resolved?.owner,
            'owner',
          );
          const confirmationId = String(
            execution.receiptId ??
              execution.confirmationId ??
              resolved?.confirmationId ??
              '',
          ).trim();

          const created = await scoped.triggerControl.createTrigger({
            definition: plan.definition,
            connectionIds: plan.connectionIds,
            actor,
            owner,
            ...(confirmationId ? { confirmationId } : {}),
          });

          value = {
            receiptId: created.receiptId,
            triggerId: created.definition?.triggerId,
            version: created.definition?.version,
            state: created.state,
            connectionIds: plan.connectionIds,
            warnings: plan.warnings ?? [],
          };
        } catch (error) {
          const canonical = fail(error, 'EVENT_TRIGGER_CREATE_FAILED');
          return projectPortableFailure(projectError, {
            capability: createCapability,
            runtimeContext,
            context: resolved,
            phase: 'trigger.create',
          }, canonical);
        }

        // Trigger creation is already durable at this point. Projection is a
        // host presentation concern, so a projection failure must never turn
        // the committed mutation into an apparent create failure that callers
        // may retry. Fall back to the canonical inline success payload.
        try {
          return await projectPortableResult(projectResult, {
            capability: createCapability,
            runtimeContext,
            context: resolved,
            value,
          });
        } catch {
          return { ok: true, data: value };
        }
      },
    },
    {
      name: toolNames.list,
      description:
        'List durable triggers owned by the current host principal. Results are compact by default and can be filtered by lifecycle status, source, target, consumption mode and remaining firings.',
      inputSchema: LIST_INPUT_SCHEMA,
      capability: listCapability,
      async execute(args, runtimeContext) {
        const parsed = TriggerListInput.safeParse(args ?? {});
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const canonical = {
            ok: false,
            error: {
              code: 'EVENT_TRIGGER_LIST_INPUT_INVALID',
              message: `${issue?.path?.join('.') || 'input'} — ${issue?.message || 'invalid'}`,
            },
          };
          return projectPortableFailure(projectError, {
            capability: listCapability,
            runtimeContext,
            context: undefined,
            phase: 'trigger.list.input',
          }, canonical);
        }

        let resolved;
        try {
          resolved = await resolveContext(runtimeContext, {
            action: 'trigger.list',
            capability: listCapability,
            input: parsed.data,
          });
          const scoped = await scopedHostFor(host, resolved);
          const { entries } = await ownedTriggerEntries(scoped, resolved);
          const filtered = filterOwnedTriggerEntries(entries, parsed.data);
          const limit = parsed.data.limit ?? 50;
          const value = {
            triggers: filtered.slice(0, limit).map((entry) =>
              compactTriggerEntry(entry, parsed.data.include_definition === true)
            ),
            total: filtered.length,
            returned: Math.min(filtered.length, limit),
          };
          return await projectPortableResult(projectResult, {
            capability: listCapability,
            runtimeContext,
            context: resolved,
            value,
          });
        } catch (error) {
          const canonical = fail(error, 'EVENT_TRIGGER_LIST_FAILED');
          return projectPortableFailure(projectError, {
            capability: listCapability,
            runtimeContext,
            context: resolved,
            phase: 'trigger.list',
          }, canonical);
        }
      },
    },
    {
      name: toolNames.inspect,
      description:
        'Inspect one durable trigger owned by the current host principal, including lifecycle and temporal state. If more than one version is eligible, specify version.',
      inputSchema: INSPECT_INPUT_SCHEMA,
      capability: inspectCapability,
      async execute(args, runtimeContext) {
        const parsed = TriggerInspectInput.safeParse(args ?? {});
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const canonical = {
            ok: false,
            error: {
              code: 'EVENT_TRIGGER_INSPECT_INPUT_INVALID',
              message: `${issue?.path?.join('.') || 'input'} — ${issue?.message || 'invalid'}`,
            },
          };
          return projectPortableFailure(projectError, {
            capability: inspectCapability,
            runtimeContext,
            context: undefined,
            phase: 'trigger.inspect.input',
          }, canonical);
        }

        let resolved;
        try {
          resolved = await resolveContext(runtimeContext, {
            action: 'trigger.inspect',
            capability: inspectCapability,
            input: parsed.data,
          });
          const scoped = await scopedHostFor(host, resolved);
          const { entries } = await ownedTriggerEntries(scoped, resolved);
          let entry;
          try {
            entry = selectOwnedTrigger(
              entries,
              parsed.data.trigger_id,
              parsed.data.version,
              parsed.data.version ? undefined : ['active', 'paused'],
            );
          } catch (error) {
            if (
              parsed.data.version ||
              error?.code !== 'TRIGGER_NOT_FOUND'
            ) throw error;
            entry = selectOwnedTrigger(
              entries,
              parsed.data.trigger_id,
              undefined,
            );
          }
          const value = await Promise.resolve(
            scoped.triggerInspector.inspect({
              triggerId: parsed.data.trigger_id,
              version: entry.definition.version,
              ...(parsed.data.match_id ? { matchId: parsed.data.match_id } : {}),
            }),
          );
          return await projectPortableResult(projectResult, {
            capability: inspectCapability,
            runtimeContext,
            context: resolved,
            value,
          });
        } catch (error) {
          const canonical = fail(error, 'EVENT_TRIGGER_INSPECT_FAILED');
          return projectPortableFailure(projectError, {
            capability: inspectCapability,
            runtimeContext,
            context: resolved,
            phase: 'trigger.inspect',
          }, canonical);
        }
      },
    },
    ...[
      {
        key: 'pause',
        action: 'trigger.pause',
        capability: pauseCapability,
        allowedStatuses: ['active'],
        method: 'pauseTrigger',
        description: 'Pause an active durable trigger owned by the current host principal.',
      },
      {
        key: 'resume',
        action: 'trigger.resume',
        capability: resumeCapability,
        allowedStatuses: ['paused'],
        method: 'resumeTrigger',
        description: 'Resume a paused durable trigger owned by the current host principal.',
      },
      {
        key: 'delete',
        action: 'trigger.delete',
        capability: deleteCapability,
        allowedStatuses: ['active', 'paused'],
        method: 'deleteTrigger',
        description: 'Delete a current durable trigger owned by the current host principal.',
      },
    ].map((spec) => ({
      name: toolNames[spec.key],
      description: spec.description,
      inputSchema: LIFECYCLE_INPUT_SCHEMA,
      capability: spec.capability,
      async execute(args, runtimeContext) {
        const parsed = TriggerLifecycleInput.safeParse(args ?? {});
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const canonical = {
            ok: false,
            error: {
              code: 'EVENT_TRIGGER_LIFECYCLE_INPUT_INVALID',
              message: `${issue?.path?.join('.') || 'input'} — ${issue?.message || 'invalid'}`,
            },
          };
          return projectPortableFailure(projectError, {
            capability: spec.capability,
            runtimeContext,
            context: undefined,
            phase: `${spec.action}.input`,
          }, canonical);
        }

        let resolved;
        let scoped;
        let entry;
        let owner;
        try {
          resolved = await resolveContext(runtimeContext, {
            action: spec.action,
            capability: spec.capability,
            input: parsed.data,
          });
          scoped = await scopedHostFor(host, resolved);
          const owned = await ownedTriggerEntries(scoped, resolved);
          owner = owned.owner;
          entry = selectOwnedTrigger(
            owned.entries,
            parsed.data.trigger_id,
            parsed.data.version,
            spec.allowedStatuses,
          );
        } catch (error) {
          const canonical = fail(error, 'EVENT_TRIGGER_LIFECYCLE_FAILED');
          return projectPortableFailure(projectError, {
            capability: spec.capability,
            runtimeContext,
            context: resolved,
            phase: `${spec.action}.resolve`,
          }, canonical);
        }

        const decision = normalizeHostControlDecision(await control({
          capability: spec.capability,
          action: spec.action,
          runtimeContext,
          context: resolved,
          input: parsed.data,
          resource: compactTriggerEntry(entry, false),
        }));
        if (decision.action === 'return') return decision.result;

        let value;
        try {
          const execution = decision.execution ?? {};
          const actor = normalizeIdentity(
            execution.actor ?? resolved?.actor,
            'actor',
          );
          const mutationOwner = normalizeIdentity(
            execution.owner ?? owner,
            'owner',
          );
          const confirmationId = String(
            execution.receiptId ??
              execution.confirmationId ??
              resolved?.confirmationId ??
              '',
          ).trim();
          const result = await scoped.triggerControl[spec.method]({
            triggerId: entry.definition.triggerId,
            version: entry.definition.version,
            actor,
            owner: mutationOwner,
            ...(confirmationId ? { confirmationId } : {}),
          });
          value = {
            receiptId: result.receiptId,
            action: result.action,
            triggerId: result.definition?.triggerId ?? entry.definition.triggerId,
            version: result.definition?.version ?? entry.definition.version,
            state: result.state,
          };
        } catch (error) {
          const canonical = fail(error, 'EVENT_TRIGGER_LIFECYCLE_FAILED');
          return projectPortableFailure(projectError, {
            capability: spec.capability,
            runtimeContext,
            context: resolved,
            phase: spec.action,
          }, canonical);
        }

        try {
          return await projectPortableResult(projectResult, {
            capability: spec.capability,
            runtimeContext,
            context: resolved,
            value,
          });
        } catch {
          return { ok: true, data: value };
        }
      },
    })),
    {
      name: toolNames.update,
      description:
        'Replace the current owned trigger with a new immutable version. Supply the complete future condition; the original continuation target is preserved.',
      inputSchema: UPDATE_INPUT_SCHEMA,
      capability: updateCapability,
      async execute(args, runtimeContext) {
        const parsed = TriggerUpdateInput.safeParse(args ?? {});
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const canonical = {
            ok: false,
            error: {
              code: 'EVENT_TRIGGER_UPDATE_INPUT_INVALID',
              message: `${issue?.path?.join('.') || 'input'} — ${issue?.message || 'invalid'}`,
            },
          };
          return projectPortableFailure(projectError, {
            capability: updateCapability,
            runtimeContext,
            context: undefined,
            phase: 'trigger.update.input',
          }, canonical);
        }

        let resolved;
        let scoped;
        let owner;
        let current;
        let plan;
        try {
          resolved = await resolveContext(runtimeContext, {
            action: 'trigger.update',
            capability: updateCapability,
            input: parsed.data,
          });
          scoped = await scopedHostFor(host, resolved);
          const owned = await ownedTriggerEntries(scoped, resolved);
          owner = owned.owner;
          current = selectOwnedTrigger(
            owned.entries,
            parsed.data.trigger_id,
            parsed.data.expected_version,
            ['active', 'paused'],
          );
          if (typeof host.refreshMcpRegistry === 'function') {
            await host.refreshMcpRegistry();
          }
          const version = parsed.data.version ?? nextPortableVersion(
            owned.entries,
            parsed.data.trigger_id,
            String(current.definition.version),
          );
          plan = await scoped.planTrigger(buildPlanInput({
            ...parsed.data,
            trigger_id: parsed.data.trigger_id,
            version,
          }, createContinuationTarget(current.definition.target)));
        } catch (error) {
          const canonical = fail(error, 'EVENT_TRIGGER_UPDATE_PLAN_FAILED');
          return projectPortableFailure(projectError, {
            capability: updateCapability,
            runtimeContext,
            context: resolved,
            phase: 'trigger.update.plan',
          }, canonical);
        }

        const decision = normalizeHostControlDecision(await control({
          capability: updateCapability,
          action: 'trigger.update',
          runtimeContext,
          context: resolved,
          input: parsed.data,
          plan,
          resource: compactTriggerEntry(current, false),
        }));
        if (decision.action === 'return') return decision.result;

        let value;
        try {
          const execution = decision.execution ?? {};
          const actor = normalizeIdentity(
            execution.actor ?? resolved?.actor,
            'actor',
          );
          const mutationOwner = normalizeIdentity(
            execution.owner ?? owner,
            'owner',
          );
          const confirmationId = String(
            execution.receiptId ??
              execution.confirmationId ??
              resolved?.confirmationId ??
              '',
          ).trim();
          const updated = await scoped.triggerControl.updateTrigger({
            triggerId: current.definition.triggerId,
            expectedVersion: current.definition.version,
            definition: plan.definition,
            connectionIds: plan.connectionIds,
            actor,
            owner: mutationOwner,
            ...(confirmationId ? { confirmationId } : {}),
          });
          value = {
            receiptId: updated.receiptId,
            action: updated.action,
            triggerId: updated.definition?.triggerId,
            previousVersion: updated.previous?.definition?.version,
            version: updated.definition?.version,
            state: updated.state,
            connectionIds: plan.connectionIds,
            warnings: plan.warnings ?? [],
          };
        } catch (error) {
          const canonical = fail(error, 'EVENT_TRIGGER_UPDATE_FAILED');
          return projectPortableFailure(projectError, {
            capability: updateCapability,
            runtimeContext,
            context: resolved,
            phase: 'trigger.update',
          }, canonical);
        }

        try {
          return await projectPortableResult(projectResult, {
            capability: updateCapability,
            runtimeContext,
            context: resolved,
            value,
          });
        } catch {
          return { ok: true, data: value };
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
  observability,
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
    observability,
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


/**
 * Runtime-level composition over the lower-level embedded host kit.
 *
 * This is deliberately not an adapter for any named runtime. It returns
 * neutral tool descriptors + capability metadata; the embedding host decides
 * how those descriptors are exposed to its model/tool system.
 */
export async function createEmbeddedRuntimeIntegration({
  dataDir,
  store,
  env = {},
  eventSources,
  mcpClients = [],
  semanticEvaluator,
  observability,
  activation,
  wake,
  wakeHandlers = {},
  tooling,
  createHost = createEventIntelligenceHost,
} = {}) {
  if (tooling !== undefined && (!tooling || typeof tooling !== 'object')) {
    throw new Error('tooling must be an object when provided');
  }
  if (tooling && typeof tooling.resolveContext !== 'function') {
    throw new Error('tooling.resolveContext() is required');
  }
  if (tooling && typeof tooling.control !== 'function') {
    throw new Error(
      'tooling.control() is required for host-owned mutation control',
    );
  }
  if (
    tooling?.projectResult !== undefined &&
    typeof tooling.projectResult !== 'function'
  ) {
    throw new Error('tooling.projectResult must be a function');
  }
  if (
    tooling?.projectError !== undefined &&
    typeof tooling.projectError !== 'function'
  ) {
    throw new Error('tooling.projectError must be a function');
  }

  const sourceRegistry = eventSources
    ? (
        typeof eventSources?.list === 'function'
          ? createEventSourceRegistry(eventSources)
          : (() => {
              const staticSources = Object.freeze([...eventSources]);
              return createEventSourceRegistry({
                list: () => staticSources,
              });
            })()
      )
    : null;

  const embedded = await createEmbeddedEventIntelligence({
    dataDir,
    store,
    env,
    ...(sourceRegistry
      ? {
          mcpRegistry: createMcpRegistryAdapter({
            listConnections: () => sourceRegistry.list(),
            ...(typeof sourceRegistry.subscribe === 'function'
              ? { subscribe: (listener) => sourceRegistry.subscribe(listener) }
              : {}),
          }),
        }
      : {}),
    mcpClients,
    semanticEvaluator,
    observability,
    activation,
    wake,
    wakeHandlers,
    createHost,
  });

  const tools = tooling
    ? createEventIntelligenceAgentTools({
        host: embedded.host,
        resolveContext: tooling.resolveContext,
        control: tooling.control,
        ...(tooling.projectResult
          ? { projectResult: tooling.projectResult }
          : {}),
        ...(tooling.projectError
          ? { projectError: tooling.projectError }
          : {}),
        names: tooling.names ?? {},
      })
    : [];
  const toolCatalog = createPortableToolCatalog(tools);

  return Object.freeze({
    ...embedded,
    tools: toolCatalog.all,
    toolCatalog,
    capabilities: Object.freeze(toolCatalog.capabilities()),
    eventSources: sourceRegistry,
    async diagnostics() {
      const refreshOutcomes = sourceRegistry ? await embedded.refresh() : [];
      return summarizeEventSourceStatus(
        await embedded.status(),
        refreshOutcomes,
      );
    },
    bind(options) {
      return bindEmbeddedRuntimeIntegration(
        {
          ...embedded,
          tools: toolCatalog.all,
        },
        options,
      );
    },
  });
}

export const PORTABLE_EVENT_INTELLIGENCE_TOOL_NAMES = DEFAULT_TOOL_NAMES;