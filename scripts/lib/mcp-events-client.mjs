import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import {
  McpEventOccurrenceSchema,
} from '../../dist/src/intelligenceProtocol/index.js';
import {
  DEFAULT_EVENT_SCOPE_ID,
  normalizeEventScopeId,
} from './persistent-event-store.mjs';
import { assertJsonSchemaValue } from './json-schema.mjs';

export { assertJsonSchemaValue } from './json-schema.mjs';

export const MCP_EVENTS_EXTENSION_ID = 'io.modelcontextprotocol/events';
const UnknownResultSchema = z.unknown();

function assertObject(value, message) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(message);
  }
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value ?? {}));
}

export function eventSubscriptionId(connectionId, eventName, args = {}) {
  const digest = createHash('sha256')
    .update(
      `${String(connectionId)}\u0000${String(eventName)}\u0000${stableJson(args)}`,
    )
    .digest('hex')
    .slice(0, 24);
  return `mcp_sub_${digest}`;
}

function normalizePositiveInteger(value, fallback, min, max, name) {
  const normalized = Number(value ?? fallback);
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return normalized;
}

function normalizeConnection(connection) {
  assertObject(connection, 'Invalid host-managed MCP Events connection');
  const connectionId = String(connection.connectionId || '').trim();
  if (!connectionId) {
    throw new Error('Host-managed MCP Events connectionId is required');
  }
  if (typeof connection.request !== 'function') {
    throw new Error(
      `Host-managed MCP Events connection ${connectionId} requires request(method, params)`,
    );
  }
  if (typeof connection.getCapabilities !== 'function') {
    throw new Error(
      `Host-managed MCP Events connection ${connectionId} requires getCapabilities()`,
    );
  }

  const preferredDelivery = connection.preferredDelivery
    ? String(connection.preferredDelivery)
    : null;
  if (
    preferredDelivery &&
    !['poll', 'push', 'webhook'].includes(preferredDelivery)
  ) {
    throw new Error(
      `Host-managed MCP Events connection ${connectionId} has invalid preferredDelivery`,
    );
  }

  return {
    connectionId,
    scopeId: normalizeEventScopeId(
      connection.scopeId ?? DEFAULT_EVENT_SCOPE_ID,
    ),
    serverId: String(connection.serverId || `host-mcp:${connectionId}`),
    request: connection.request,
    getCapabilities: connection.getCapabilities,
    identity: connection.identity ?? connection.request,
    enabled: connection.enabled !== false,
    pollIntervalMs: normalizePositiveInteger(
      connection.pollIntervalMs,
      5000,
      250,
      300000,
      'pollIntervalMs',
    ),
    maxEvents: normalizePositiveInteger(
      connection.maxEvents,
      100,
      1,
      500,
      'maxEvents',
    ),
    maxPollBatches: normalizePositiveInteger(
      connection.maxPollBatches,
      4,
      1,
      32,
      'maxPollBatches',
    ),
    preferredDelivery,
    openEventStream:
      typeof connection.openEventStream === 'function'
        ? connection.openEventStream
        : null,
    createWebhookSubscription:
      typeof connection.createWebhookSubscription === 'function'
        ? connection.createWebhookSubscription
        : null,
  };
}

/**
 * Adapt an MCP client already connected and authorized by the host.
 *
 * Poll works with the ordinary MCP request surface. Push and webhook remain
 * host-owned transport concerns: a host can provide openEventStream() and/or
 * createWebhookSubscription() adapters without giving Event Intelligence
 * transport credentials or callback infrastructure.
 */
export function createHostMcpEventsConnection({
  connectionId,
  serverId,
  client,
  request,
  getCapabilities,
  capabilities,
  enabled = true,
  pollIntervalMs = 5000,
  maxEvents = 100,
  maxPollBatches = 4,
  scopeId = DEFAULT_EVENT_SCOPE_ID,
  preferredDelivery,
  openEventStream,
  createWebhookSubscription,
} = {}) {
  const directRequest =
    typeof request === 'function'
      ? request
      : client && typeof client.request === 'function'
        ? async (method, params) => {
            const message = {
              method,
              ...(params === undefined ? {} : { params }),
            };
            return client.request(message, UnknownResultSchema);
          }
        : null;

  const directCapabilities =
    typeof getCapabilities === 'function'
      ? getCapabilities
      : client && typeof client.getServerCapabilities === 'function'
        ? async () => client.getServerCapabilities()
        : capabilities && typeof capabilities === 'object'
          ? async () => capabilities
          : null;

  return normalizeConnection({
    connectionId,
    serverId,
    request: directRequest,
    getCapabilities: directCapabilities,
    identity: client ?? request ?? directRequest,
    enabled,
    pollIntervalMs,
    maxEvents,
    maxPollBatches,
    scopeId,
    preferredDelivery,
    openEventStream,
    createWebhookSubscription,
  });
}

function sourceDescriptor(raw) {
  const descriptor = assertObject(raw, 'Invalid MCP event descriptor');
  const name = String(descriptor.name || '').trim();
  if (!name) throw new Error('MCP event descriptor requires name');
  const delivery = Array.isArray(descriptor.delivery)
    ? descriptor.delivery.map(String)
    : [];
  if (
    delivery.length === 0 ||
    delivery.some((mode) => !['poll', 'push', 'webhook'].includes(mode))
  ) {
    throw new Error(`MCP event descriptor ${name} has invalid delivery modes`);
  }
  return {
    name,
    description: String(descriptor.description || ''),
    delivery,
    inputSchema:
      descriptor.inputSchema &&
      !Array.isArray(descriptor.inputSchema) &&
      typeof descriptor.inputSchema === 'object'
        ? descriptor.inputSchema
        : {},
    payloadSchema:
      descriptor.payloadSchema &&
      !Array.isArray(descriptor.payloadSchema) &&
      typeof descriptor.payloadSchema === 'object'
        ? descriptor.payloadSchema
        : {},
    ...(descriptor._meta &&
    !Array.isArray(descriptor._meta) &&
    typeof descriptor._meta === 'object'
      ? { _meta: descriptor._meta }
      : {}),
  };
}

function normalizeCursor(cursor, label) {
  if (cursor === null) return null;
  if (typeof cursor === 'string') return cursor;
  throw new Error(`${label} returned invalid cursor; expected string|null`);
}

function normalizeNextPollMs(value, fallback) {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < 0 || result > 300000) {
    throw new Error('events/poll returned invalid nextPollMs');
  }
  return result;
}

function supportsMode(connection, mode) {
  if (mode === 'poll') return true;
  if (mode === 'push') return typeof connection.openEventStream === 'function';
  if (mode === 'webhook') {
    return typeof connection.createWebhookSubscription === 'function';
  }
  return false;
}

function chooseDelivery(connection, descriptor) {
  const advertised = descriptor.delivery;
  if (
    connection.preferredDelivery &&
    advertised.includes(connection.preferredDelivery) &&
    supportsMode(connection, connection.preferredDelivery)
  ) {
    return connection.preferredDelivery;
  }

  for (const mode of ['push', 'webhook', 'poll']) {
    if (advertised.includes(mode) && supportsMode(connection, mode)) {
      return mode;
    }
  }
  return null;
}

export class McpEventsClientManager {
  constructor({
    store,
    compositeEventConsumer,
    registerEventSource,
    resolveScope = null,
    connections = [],
    now = () => new Date(),
  }) {
    this.store = store;
    this.compositeEventConsumer = compositeEventConsumer;
    this.registerEventSource = registerEventSource;
    this.resolveScope = resolveScope;
    this.connections = new Map();
    this.now = now;
    this.descriptors = new Map();
    this.timers = new Map();
    this.lastErrors = new Map();
    this.scopeContexts = new Map();
    this.pollInFlight = new Map();
    this.deliverySessions = new Map();
    this.started = false;

    for (const connection of connections) {
      this.addConnection(connection);
    }
  }

  async scopeContext(connection) {
    const cacheKey = `${connection.connectionId}::${connection.scopeId}`;
    const cached = this.scopeContexts.get(cacheKey);
    if (cached) return cached;

    const context =
      typeof this.resolveScope === 'function'
        ? await this.resolveScope(connection.scopeId)
        : {
            store: this.store,
            compositeEventConsumer: this.compositeEventConsumer,
            triggerControl: null,
          };

    if (!context || !context.store || !context.compositeEventConsumer) {
      throw new Error(
        `Invalid Event Intelligence scope context for ${connection.scopeId}`,
      );
    }

    this.scopeContexts.set(cacheKey, context);
    return context;
  }

  addConnection(input) {
    const connection = normalizeConnection(input);
    if (connection.enabled === false) return connection;
    if (this.connections.has(connection.connectionId)) {
      throw new Error(
        `Host-managed MCP Events connection already attached: ${connection.connectionId}`,
      );
    }
    this.connections.set(connection.connectionId, connection);
    return connection;
  }

  async attachConnection(input, { discover = true } = {}) {
    const connection = this.addConnection(input);
    let events = [];
    if (connection.enabled !== false && discover) {
      events = await this.discoverConnection(connection.connectionId);
    }
    if (connection.enabled !== false && this.started) {
      this.scheduleConnection(connection, 0);
    }
    return {
      connectionId: connection.connectionId,
      events,
    };
  }

  async closeSession(subscriptionId) {
    const session = this.deliverySessions.get(subscriptionId);
    if (!session) return false;
    this.deliverySessions.delete(subscriptionId);
    try {
      if (typeof session.close === 'function') await session.close();
    } catch {
      // Closing stale delivery sessions is best effort.
    }
    return true;
  }

  async detachConnection(connectionId) {
    const timer = this.timers.get(connectionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(connectionId);
    this.descriptors.delete(connectionId);
    this.lastErrors.delete(connectionId);
    this.pollInFlight.delete(connectionId);

    for (const [subscriptionId, session] of this.deliverySessions) {
      if (session.connectionId === connectionId) {
        await this.closeSession(subscriptionId);
      }
    }

    const connection = this.connections.get(connectionId);
    const context = connection ? await this.scopeContext(connection) : null;
    if (connection) {
      this.scopeContexts.delete(
        `${connection.connectionId}::${connection.scopeId}`,
      );
    }
    const removed = this.connections.delete(connectionId);
    if (removed && context) {
      const sources = context.store.listEventSources({
        connectionIds: [connectionId],
      });
      for (const source of sources) {
        if (source.enabled === false) continue;
        const register = context.triggerControl?.registerEventSource
          ? (sourceInput, actor) =>
              context.triggerControl.registerEventSource(sourceInput, actor)
          : async (sourceInput) => this.registerEventSource(sourceInput);
        await register(
          {
            ...source,
            enabled: false,
          },
          {
            type: 'system',
            principal_id: 'event-intelligence:host-mcp-client',
          },
        );
      }
    }
    return removed;
  }

  async rpc(connection, method, params) {
    try {
      return await connection.request(method, params);
    } catch (error) {
      throw new Error(
        `Host MCP ${connection.connectionId} ${method} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async discoverConnection(connectionId) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(
        `Unknown host-managed MCP Events connection: ${connectionId}`,
      );
    }

    const context = await this.scopeContext(connection);
    const capabilities = (await connection.getCapabilities()) ?? {};
    const extensions =
      capabilities.extensions &&
      !Array.isArray(capabilities.extensions) &&
      typeof capabilities.extensions === 'object'
        ? capabilities.extensions
        : {};
    if (
      !Object.prototype.hasOwnProperty.call(
        extensions,
        MCP_EVENTS_EXTENSION_ID,
      )
    ) {
      const error = new Error(
        `MCP server ${connectionId} does not advertise ${MCP_EVENTS_EXTENSION_ID}`,
      );
      error.code = 'MCP_EVENTS_CAPABILITY_UNAVAILABLE';
      throw error;
    }

    const descriptors = [];
    const names = new Set();
    let cursor = null;
    do {
      const listed = await this.rpc(
        connection,
        'events/list',
        cursor ? { cursor } : {},
      );
      if (!Array.isArray(listed?.events)) {
        throw new Error(
          `MCP server ${connectionId} returned invalid events/list`,
        );
      }
      for (const raw of listed.events) {
        const descriptor = sourceDescriptor(raw);
        if (names.has(descriptor.name)) {
          throw new Error(
            `MCP server ${connectionId} returned duplicate event descriptor ${descriptor.name}`,
          );
        }
        names.add(descriptor.name);
        descriptors.push(descriptor);
      }
      cursor =
        listed?.nextCursor === undefined || listed?.nextCursor === null
          ? null
          : String(listed.nextCursor);
    } while (cursor);

    for (const normalized of descriptors) {
      const sourceId =
        `mcp:${connection.connectionId}:${normalized.name}`;
      const existing = context.store
        .listEventSources()
        .find((source) => source.sourceId === sourceId);
      const same =
        existing &&
        existing.enabled !== false &&
        existing.connectionId === connection.connectionId &&
        existing.serverId === connection.serverId &&
        existing.eventName === normalized.name &&
        JSON.stringify(existing.delivery) ===
          JSON.stringify(normalized.delivery) &&
        JSON.stringify(existing.inputSchema || {}) ===
          JSON.stringify(normalized.inputSchema) &&
        JSON.stringify(existing.payloadSchema || {}) ===
          JSON.stringify(normalized.payloadSchema);

      if (!same) {
        const register = context.triggerControl?.registerEventSource
          ? (sourceInput, actor) =>
              context.triggerControl.registerEventSource(sourceInput, actor)
          : async (sourceInput) => this.registerEventSource(sourceInput);
        await register(
          {
            sourceId,
            connectionId: connection.connectionId,
            serverId: connection.serverId,
            eventName: normalized.name,
            description: normalized.description,
            delivery: normalized.delivery,
            inputSchema: normalized.inputSchema,
            payloadSchema: normalized.payloadSchema,
            enabled: true,
            experimental: true,
            metadata: {
              transport: 'host-managed-mcp',
              hostManaged: true,
              extensionId: MCP_EVENTS_EXTENSION_ID,
              ...(normalized._meta ? { descriptorMeta: normalized._meta } : {}),
            },
          },
          {
            type: 'system',
            principal_id: 'event-intelligence:host-mcp-client',
          },
        );
      }
    }

    this.descriptors.set(connection.connectionId, descriptors);
    this.lastErrors.delete(connection.connectionId);
    return descriptors;
  }

  async discoverAll() {
    const results = [];
    for (const connection of this.connections.values()) {
      try {
        const events = await this.discoverConnection(connection.connectionId);
        results.push({
          connectionId: connection.connectionId,
          status: 'ready',
          events: events.map((event) => event.name),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastErrors.set(connection.connectionId, message);
        results.push({
          connectionId: connection.connectionId,
          status:
            error?.code === 'MCP_EVENTS_CAPABILITY_UNAVAILABLE'
              ? 'ignored_no_events'
              : 'error',
          ...(error?.code === 'MCP_EVENTS_CAPABILITY_UNAVAILABLE'
            ? {}
            : { error: message }),
        });
      }
    }
    return results;
  }

  desiredSubscriptions(connection, context) {
    const descriptors = this.descriptors.get(connection.connectionId) || [];
    const byName = new Map(descriptors.map((item) => [item.name, item]));
    const desired = new Map();
    const triggers =
      typeof context.triggerControl?.listTriggers === 'function'
        ? context.triggerControl.listTriggers()
        : typeof context.store?.listTriggers === 'function'
          ? context.store.listTriggers().map((definition) => ({
              definition,
              state:
                typeof context.store.getTriggerState === 'function'
                  ? context.store.getTriggerState(
                      definition.triggerId,
                      definition.version,
                    )
                  : null,
            }))
          : [];

    for (const { definition, state } of triggers) {
      if (state?.status !== 'active') continue;
      for (const clause of definition.clauses ?? []) {
        if (clause.serverId !== connection.serverId) continue;
        const descriptor = byName.get(clause.event);
        if (!descriptor) continue;
        const args =
          clause.arguments &&
          !Array.isArray(clause.arguments) &&
          typeof clause.arguments === 'object'
            ? clause.arguments
            : {};
        const subscriptionId = eventSubscriptionId(
          connection.connectionId,
          clause.event,
          args,
        );
        if (!desired.has(subscriptionId)) {
          desired.set(subscriptionId, {
            subscriptionId,
            eventName: clause.event,
            arguments: args,
            descriptor,
          });
        }
      }
    }

    return desired;
  }

  async ingestOccurrence(connection, context, descriptor, raw) {
    const occurrence = McpEventOccurrenceSchema.parse(raw);
    if (occurrence.name !== descriptor.name) {
      throw new Error(
        `MCP event name mismatch: expected ${descriptor.name}, got ${occurrence.name}`,
      );
    }
    assertJsonSchemaValue(descriptor.payloadSchema, occurrence.data);

    const receipt = await context.store.appendMcpOccurrence(
      connection.serverId,
      occurrence,
    );
    if (!receipt.accepted) return { accepted: false, occurrence };

    await context.compositeEventConsumer.ingestMcpOccurrence({
      event: occurrence,
      serverId: connection.serverId,
      provider: 'mcp',
      traceId: `mcp:${connection.serverId}:${occurrence.eventId}`,
    });
    return { accepted: true, occurrence };
  }

  async saveSubscriptionState(
    connection,
    context,
    subscription,
    patch = {},
  ) {
    const previous = context.store.getMcpClientState(
      connection.connectionId,
      subscription.eventName,
      subscription.arguments,
    );
    return context.store.putMcpClientState({
      ...(previous || {}),
      connectionId: connection.connectionId,
      serverId: connection.serverId,
      eventName: subscription.eventName,
      arguments: subscription.arguments,
      subscriptionId: subscription.subscriptionId,
      ...patch,
    });
  }

  async pollSubscription(
    connection,
    context,
    subscription,
    { respectSchedule = false } = {},
  ) {
    const store = context.store;
    const current = store.getMcpClientState(
      connection.connectionId,
      subscription.eventName,
      subscription.arguments,
    );
    if (
      respectSchedule &&
      current?.nextPollAt &&
      Date.parse(current.nextPollAt) > this.now().getTime()
    ) {
      return {
        subscriptionId: subscription.subscriptionId,
        eventName: subscription.eventName,
        delivery: 'poll',
        status: 'scheduled',
        accepted: 0,
        cursor: current.cursor,
        nextPollAt: current.nextPollAt,
      };
    }

    let cursor = current?.cursor ?? null;
    let lastEventAt = current?.lastEventAt;
    let accepted = 0;
    let batches = 0;
    let hasMore = false;
    let truncated = false;
    let nextPollMs = connection.pollIntervalMs;

    do {
      const result = await this.rpc(connection, 'events/poll', {
        name: subscription.eventName,
        arguments: subscription.arguments,
        cursor,
        maxEvents: connection.maxEvents,
      });

      if (!Array.isArray(result?.events)) {
        throw new Error(
          `MCP server ${connection.connectionId} returned invalid events/poll`,
        );
      }
      cursor = normalizeCursor(
        result.cursor,
        `MCP server ${connection.connectionId} events/poll`,
      );
      hasMore = result.hasMore === true;
      truncated = truncated || result.truncated === true;
      nextPollMs = normalizeNextPollMs(
        result.nextPollMs,
        connection.pollIntervalMs,
      );

      for (const raw of result.events) {
        const receipt = await this.ingestOccurrence(
          connection,
          context,
          subscription.descriptor,
          raw,
        );
        if (!receipt.accepted) continue;
        accepted += 1;
        lastEventAt = receipt.occurrence.timestamp;
      }

      batches += 1;
      const nextPollAt = new Date(
        this.now().getTime() + (hasMore ? 0 : nextPollMs),
      ).toISOString();
      await this.saveSubscriptionState(
        connection,
        context,
        subscription,
        {
          deliveryMode: 'poll',
          cursor,
          truncated,
          nextPollAt,
          ...(lastEventAt ? { lastEventAt } : {}),
        },
      );
    } while (hasMore && batches < connection.maxPollBatches);

    this.lastErrors.delete(connection.connectionId);
    return {
      subscriptionId: subscription.subscriptionId,
      eventName: subscription.eventName,
      delivery: 'poll',
      status: 'ok',
      accepted,
      cursor,
      truncated,
      hasMore,
      batches,
      nextPollMs,
      batchLimitReached: hasMore && batches >= connection.maxPollBatches,
    };
  }

  async ensureDeliverySession(
    connection,
    context,
    subscription,
    delivery,
  ) {
    const existing = this.deliverySessions.get(subscription.subscriptionId);
    if (existing?.delivery === delivery) {
      return {
        subscriptionId: subscription.subscriptionId,
        eventName: subscription.eventName,
        delivery,
        status: 'active',
        accepted: existing.accepted,
      };
    }
    if (existing) await this.closeSession(subscription.subscriptionId);

    const current = context.store.getMcpClientState(
      connection.connectionId,
      subscription.eventName,
      subscription.arguments,
    );
    let accepted = 0;

    const onEvent = async (raw) => {
      const receipt = await this.ingestOccurrence(
        connection,
        context,
        subscription.descriptor,
        raw,
      );
      if (receipt.accepted) accepted += 1;
      if (Object.prototype.hasOwnProperty.call(raw ?? {}, 'cursor')) {
        await this.saveSubscriptionState(
          connection,
          context,
          subscription,
          {
            deliveryMode: delivery,
            cursor: normalizeCursor(
              raw.cursor,
              `${delivery} event ${subscription.eventName}`,
            ),
            ...(receipt.accepted
              ? { lastEventAt: receipt.occurrence.timestamp }
              : {}),
          },
        );
      }
    };

    const onActive = async (update = {}) => {
      const patch = {
        deliveryMode: delivery,
        ...(Object.prototype.hasOwnProperty.call(update, 'cursor')
          ? {
              cursor: normalizeCursor(
                update.cursor,
                `${delivery} active ${subscription.eventName}`,
              ),
            }
          : {}),
        ...(typeof update.truncated === 'boolean'
          ? { truncated: update.truncated }
          : {}),
      };
      await this.saveSubscriptionState(
        connection,
        context,
        subscription,
        patch,
      );
    };

    const onGap = async (update = {}) => {
      await onActive({ ...update, truncated: true });
    };

    const onError = (error) => {
      this.lastErrors.set(
        connection.connectionId,
        error instanceof Error ? error.message : String(error),
      );
    };

    const onTerminated = async (detail) => {
      this.deliverySessions.delete(subscription.subscriptionId);
      if (detail) {
        this.lastErrors.set(
          connection.connectionId,
          typeof detail === 'string' ? detail : JSON.stringify(detail),
        );
      }
    };

    const open =
      delivery === 'push'
        ? connection.openEventStream
        : connection.createWebhookSubscription;
    const handle = await open({
      subscriptionId: subscription.subscriptionId,
      name: subscription.eventName,
      arguments: subscription.arguments,
      cursor: current?.cursor ?? null,
      onEvent,
      onActive,
      onGap,
      onError,
      onTerminated,
    });

    const close =
      typeof handle === 'function'
        ? handle
        : typeof handle?.close === 'function'
          ? () => handle.close()
          : typeof handle?.cancel === 'function'
            ? () => handle.cancel()
            : typeof handle?.unsubscribe === 'function'
              ? () => handle.unsubscribe()
              : async () => {};

    if (handle && Object.prototype.hasOwnProperty.call(handle, 'cursor')) {
      await onActive({
        cursor: handle.cursor,
        truncated: handle.truncated === true,
      });
    } else {
      await this.saveSubscriptionState(
        connection,
        context,
        subscription,
        {
          deliveryMode: delivery,
          cursor: current?.cursor ?? null,
        },
      );
    }

    this.deliverySessions.set(subscription.subscriptionId, {
      connectionId: connection.connectionId,
      delivery,
      close,
      get accepted() {
        return accepted;
      },
    });
    this.lastErrors.delete(connection.connectionId);

    return {
      subscriptionId: subscription.subscriptionId,
      eventName: subscription.eventName,
      delivery,
      status: 'active',
      accepted,
    };
  }

  async reconcileDeliverySessions(connection, desiredIds) {
    for (const [subscriptionId, session] of this.deliverySessions) {
      if (
        session.connectionId === connection.connectionId &&
        !desiredIds.has(subscriptionId)
      ) {
        await this.closeSession(subscriptionId);
      }
    }
  }

  async pollConnection(connectionId, options = {}) {
    const existing = this.pollInFlight.get(connectionId);
    if (existing) return existing;

    const task = this.pollConnectionOnce(connectionId, options);
    this.pollInFlight.set(connectionId, task);
    try {
      return await task;
    } finally {
      if (this.pollInFlight.get(connectionId) === task) {
        this.pollInFlight.delete(connectionId);
      }
    }
  }

  async pollConnectionOnce(
    connectionId,
    { respectSchedule = false } = {},
  ) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(
        `Unknown host-managed MCP Events connection: ${connectionId}`,
      );
    }

    const context = await this.scopeContext(connection);
    let descriptors = this.descriptors.get(connectionId);
    if (!descriptors) {
      descriptors = await this.discoverConnection(connectionId);
    }

    const desired = this.desiredSubscriptions(connection, context);
    const desiredIds = new Set(desired.keys());
    const results = [];

    for (const subscription of desired.values()) {
      const delivery = chooseDelivery(connection, subscription.descriptor);
      if (!delivery) {
        results.push({
          subscriptionId: subscription.subscriptionId,
          eventName: subscription.eventName,
          status: 'delivery_not_supported',
          delivery: null,
          accepted: 0,
        });
        continue;
      }

      if (delivery === 'poll') {
        await this.closeSession(subscription.subscriptionId);
        results.push(
          await this.pollSubscription(
            connection,
            context,
            subscription,
            { respectSchedule },
          ),
        );
      } else {
        results.push(
          await this.ensureDeliverySession(
            connection,
            context,
            subscription,
            delivery,
          ),
        );
      }
    }

    await this.reconcileDeliverySessions(connection, desiredIds);
    return results;
  }

  async pollAll(options = {}) {
    const results = [];
    for (const connection of this.connections.values()) {
      try {
        results.push({
          connectionId: connection.connectionId,
          results: await this.pollConnection(
            connection.connectionId,
            options,
          ),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastErrors.set(connection.connectionId, message);
        results.push({
          connectionId: connection.connectionId,
          error: message,
        });
      }
    }
    return results;
  }

  nextDelay(connection) {
    const context = this.scopeContexts.get(
      `${connection.connectionId}::${connection.scopeId}`,
    );
    if (!context) return connection.pollIntervalMs;
    const states = context.store.listMcpClientStates(
      connection.connectionId,
    );
    const now = this.now().getTime();
    const due = states
      .map((state) => Date.parse(state.nextPollAt || ''))
      .filter(Number.isFinite)
      .map((time) => Math.max(250, time - now));
    return due.length
      ? Math.min(connection.pollIntervalMs, ...due)
      : connection.pollIntervalMs;
  }

  scheduleConnection(connection, delay = connection.pollIntervalMs) {
    const existing = this.timers.get(connection.connectionId);
    if (existing) clearTimeout(existing);
    if (!this.started) return;

    const timer = setTimeout(async () => {
      try {
        await this.pollConnection(
          connection.connectionId,
          { respectSchedule: true },
        );
      } catch (error) {
        this.lastErrors.set(
          connection.connectionId,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (
          this.started &&
          this.connections.get(connection.connectionId) === connection
        ) {
          this.scheduleConnection(connection, this.nextDelay(connection));
        }
      }
    }, Math.max(0, delay));
    timer.unref?.();
    this.timers.set(connection.connectionId, timer);
  }

  start() {
    this.started = true;
    for (const connection of this.connections.values()) {
      this.scheduleConnection(connection, 0);
    }
  }

  async stop() {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const subscriptionId of [...this.deliverySessions.keys()]) {
      await this.closeSession(subscriptionId);
    }
  }

  async drain() {
    while (this.pollInFlight.size > 0) {
      await Promise.allSettled([...this.pollInFlight.values()]);
    }
  }

  async close() {
    await this.stop();
    await this.drain();
  }

  status() {
    return [...this.connections.values()].map((connection) => {
      const context = this.scopeContexts.get(
        `${connection.connectionId}::${connection.scopeId}`,
      );
      const store = context?.store ?? this.store;
      const states = store.listMcpClientStates(connection.connectionId);
      return {
        connectionId: connection.connectionId,
        scopeId: connection.scopeId,
        serverId: connection.serverId,
        hostManaged: true,
        extensionId: MCP_EVENTS_EXTENSION_ID,
        events: (this.descriptors.get(connection.connectionId) || []).map(
          (event) => ({
            name: event.name,
            delivery: event.delivery,
            subscriptions: states
              .filter((state) => state.eventName === event.name)
              .map((state) => ({
                subscriptionId: state.subscriptionId,
                arguments: state.arguments ?? {},
                delivery: state.deliveryMode,
                cursor: state.cursor,
                nextPollAt: state.nextPollAt ?? null,
                truncated: state.truncated ?? false,
              })),
          }),
        ),
        error: this.lastErrors.get(connection.connectionId) ?? null,
      };
    });
  }
}
