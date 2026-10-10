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
import {
  MCP_EVENTS_EXTENSION_ID,
  getMcpEventsCompatibilityProfile,
  resolveMcpEventsCompatibilityProfile,
} from './mcp-events-compatibility.mjs';

export { assertJsonSchemaValue } from './json-schema.mjs';
export { MCP_EVENTS_EXTENSION_ID } from './mcp-events-compatibility.mjs';
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
    compatibilityProfile:
      connection.compatibilityProfile === undefined
        ? 'auto'
        : String(connection.compatibilityProfile),
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
  compatibilityProfile = 'auto',
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
    compatibilityProfile,
    openEventStream,
    createWebhookSubscription,
  });
}

function sourceDescriptor(raw, profile) {
  const descriptor = assertObject(raw, 'Invalid MCP event descriptor');
  const name = String(descriptor.name || '').trim();
  if (!name) throw new Error('MCP event descriptor requires name');
  const delivery = Array.isArray(descriptor.delivery)
    ? descriptor.delivery.map(String)
    : [];
  if (
    delivery.length === 0 ||
    delivery.some((mode) => !profile.deliveryModes.includes(mode))
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
    observability = null,
  }) {
    this.store = store;
    this.compositeEventConsumer = compositeEventConsumer;
    this.registerEventSource = registerEventSource;
    this.resolveScope = resolveScope;
    this.connections = new Map();
    this.now = now;
    this.observability = observability;
    this.descriptors = new Map();
    this.profiles = new Map();
    this.timers = new Map();
    this.lastErrors = new Map();
    this.scopeContexts = new Map();
    this.pollInFlight = new Map();
    // Serialize durable source/cursor mutations by connection ID, including
    // detach's disable operation. A new session cannot overwrite or race
    // old-session cleanup even when it reuses the same connection ID.
    this.connectionMutations = new Map();
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

  /** Compare the actual host-owned connection object, not just its ID.
   * A revoked session and a replacement can legitimately reuse connectionId.
   */
  isConnectionAttached(connection) {
    return connection?.enabled !== false &&
      this.connections.get(connection?.connectionId) === connection;
  }

  assertConnectionAttached(connection) {
    if (!this.isConnectionAttached(connection)) {
      const error = new Error('Host MCP Events connection is detached');
      error.code = 'MCP_EVENTS_CONNECTION_DETACHED';
      throw error;
    }
  }

  withConnectionMutation(connectionId, operation) {
    const previous = this.connectionMutations.get(connectionId)
      ?? Promise.resolve();
    // Never leave the queue poisoned by a failed previous mutation.
    const result = previous.then(operation);
    const settled = result.then(() => {}, () => {});
    this.connectionMutations.set(connectionId, settled);
    void settled.then(() => {
      if (this.connectionMutations.get(connectionId) === settled) {
        this.connectionMutations.delete(connectionId);
      }
    });
    return result;
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

  async closeSession(subscriptionId, expectedSession = null) {
    const session = this.deliverySessions.get(subscriptionId);
    if (!session || (expectedSession && session !== expectedSession)) return false;
    this.deliverySessions.delete(subscriptionId);
    try {
      if (typeof session.close === 'function') await session.close();
    } catch {
      // Closing stale delivery sessions is best effort.
    }
    return true;
  }

  async detachConnection(connectionId) {
    // Revoke authority synchronously. Reserve cleanup in the *same* durable
    // mutation queue before the first await, so new sessions cannot discover
    // sources or persist cursors ahead of the old disable operation.
    const connection = this.connections.get(connectionId);
    const removed = this.connections.delete(connectionId);
    const cleanup = removed
      ? this.withConnectionMutation(connectionId, async () => {
          const context = await this.scopeContext(connection);
          const sources = await context.store.listEventSources({
            connectionIds: [connectionId],
          });
          for (const source of sources) {
            if (source.enabled === false) continue;
            const register = context.triggerControl?.registerEventSource
              ? (input, actor) =>
                  context.triggerControl.registerEventSource(input, actor)
              : async (input) => this.registerEventSource(input);
            await register(
              { ...source, enabled: false },
              {
                type: 'system',
                principal_id: 'event-intelligence:host-mcp-client',
              },
            );
          }
        })
      : Promise.resolve();
    const timer = this.timers.get(connectionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(connectionId);
    this.descriptors.delete(connectionId);
    this.profiles.delete(connectionId);
    this.lastErrors.delete(connectionId);
    this.pollInFlight.delete(connectionId);

    // Snapshot ONLY sessions owned by this connection object. Async close
    // must never visit or remove replacement sessions registered mid-cleanup.
    const previousSessions = [...this.deliverySessions].filter(
      ([, session]) => session.connection === connection,
    );
    await Promise.all(previousSessions.map(([id,session]) =>
      this.closeSession(id,session)
    ));
    try {
      await cleanup;
    } finally {
      const key = `${connection?.connectionId}::${connection?.scopeId}`;
      // Scope contexts are keyed by ID+scope, and may already be reused by
      // a replacement. Never clear a context while a replacement is live.
      if (connection && !this.connections.has(connectionId)) {
        this.scopeContexts.delete(key);
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
    this.assertConnectionAttached(connection);
    const profile = resolveMcpEventsCompatibilityProfile({
      capabilities,
      requested: connection.compatibilityProfile,
    });
    if (!profile) {
      const expected = getMcpEventsCompatibilityProfile(
        connection.compatibilityProfile,
      );
      const error = new Error(
        `MCP server ${connectionId} does not advertise the ${expected.id} Events profile`,
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
        profile.listMethod,
        cursor ? { cursor } : {},
      );
      this.assertConnectionAttached(connection);
      if (!Array.isArray(listed?.events)) {
        throw new Error(
          `MCP server ${connectionId} returned invalid events/list`,
        );
      }
      for (const raw of listed.events) {
        const descriptor = sourceDescriptor(raw, profile);
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
      await this.withConnectionMutation(connectionId, async () => {
        this.assertConnectionAttached(connection);
        const sourceId =
        `mcp:${connection.connectionId}:${normalized.name}`;
      const existing = (
        await context.store.listEventSources()
      ).find((source) => source.sourceId === sourceId);
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
          JSON.stringify(normalized.payloadSchema) &&
        existing.metadata?.compatibilityProfile === profile.id &&
        existing.metadata?.extensionId === profile.extensionId;

      if (!same) {
        this.assertConnectionAttached(connection);
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
              extensionId: profile.extensionId,
              compatibilityProfile: profile.id,
              ...(normalized._meta ? { descriptorMeta: normalized._meta } : {}),
            },
          },
          {
            type: 'system',
            principal_id: 'event-intelligence:host-mcp-client',
          },
        );
      }
        this.assertConnectionAttached(connection);
      });
    }

    this.assertConnectionAttached(connection);
    this.descriptors.set(connection.connectionId, descriptors);
    this.profiles.set(connection.connectionId, profile);
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

  async desiredSubscriptions(connection, context) {
    const descriptors = this.descriptors.get(connection.connectionId) || [];
    const byName = new Map(descriptors.map((item) => [item.name, item]));
    const desired = new Map();
    let triggers = [];
    if (typeof context.triggerControl?.listTriggers === 'function') {
      triggers = await context.triggerControl.listTriggers();
    } else if (typeof context.store?.listTriggers === 'function') {
      const definitions = await context.store.listTriggers();
      triggers = await Promise.all(definitions.map(async (definition) => ({
        definition,
        state:
          typeof context.store.getTriggerState === 'function'
            ? await context.store.getTriggerState(
              definition.triggerId,
              definition.version,
            )
            : null,
      })));
    }

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
        const consumerRef =
          `${definition.triggerId}@${definition.version}:${clause.id}`;
        const existing = desired.get(subscriptionId);
        if (existing) {
          existing.consumerRefs.push(consumerRef);
        } else {
          desired.set(subscriptionId, {
            subscriptionId,
            eventName: clause.event,
            arguments: args,
            descriptor,
            consumerRefs: [consumerRef],
          });
        }
      }
    }

    return desired;
  }

  async ingestOccurrence(connection, context, subscription, raw) {
    // Do not even parse untrusted payloads from a revoked/replaced session.
    if (!this.isConnectionAttached(connection)) {
      return { accepted: false, reason: 'detached' };
    }
    const descriptor = subscription.descriptor;
    const occurrence = McpEventOccurrenceSchema.parse(raw);
    if (occurrence.name !== descriptor.name) {
      throw new Error(
        `MCP event name mismatch: expected ${descriptor.name}, got ${occurrence.name}`,
      );
    }
    assertJsonSchemaValue(descriptor.payloadSchema, occurrence.data);

    const receivedAt = this.now().toISOString();
    const receipt = await context.store.appendMcpOccurrence(
      connection.serverId,
      occurrence,
      subscription.subscriptionId,
    );
    if (!receipt.accepted) return { accepted: false, occurrence };
    // The host might revoke the MCP session while appendMcpOccurrence was
    // awaiting storage. Failing closed takes precedence over delivery.
    // A raced append may remain durable: see explicit race limitation docs.
    if (!this.isConnectionAttached(connection)) {
      return { accepted: false, reason: 'detached' };
    }

    await context.compositeEventConsumer.ingestMcpOccurrence({
      event: occurrence,
      serverId: connection.serverId,
      provider: 'mcp',
      traceId:
        `mcp:${connection.serverId}:${subscription.subscriptionId}:${occurrence.eventId}`,
      subscriptionArguments: subscription.arguments,
      receivedAt,
    });
    return { accepted: true, occurrence };
  }

  async saveSubscriptionState(
    connection,
    context,
    subscription,
    patch = {},
  ) {
    // Serialize both read and write with source registration and detach.
    // An already-started old put finishes BEFORE new-session cursor writes,
    // while a not-yet-started old operation rejects after revoke.
    return this.withConnectionMutation(connection.connectionId, async () => {
      this.assertConnectionAttached(connection);
      const previous = await context.store.getMcpClientState(
        connection.connectionId,
        subscription.eventName,
        subscription.arguments,
      );
      this.assertConnectionAttached(connection);
      return context.store.putMcpClientState({
        ...(previous || {}),
        connectionId: connection.connectionId,
        serverId: connection.serverId,
        eventName: subscription.eventName,
        arguments: subscription.arguments,
        subscriptionId: subscription.subscriptionId,
        ...patch,
      });
    });
  }

  async pollSubscription(
    connection,
    context,
    subscription,
    { respectSchedule = false } = {},
  ) {
    this.assertConnectionAttached(connection);
    const store = context.store;
    const current = await store.getMcpClientState(
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
        consumerCount: subscription.consumerRefs.length,
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
      const profile =
        this.profiles.get(connection.connectionId) ??
        getMcpEventsCompatibilityProfile(connection.compatibilityProfile);
      const result = await this.rpc(connection, profile.pollMethod, {
        name: subscription.eventName,
        arguments: subscription.arguments,
        cursor,
        maxEvents: connection.maxEvents,
      });
      // Do not process an RPC response which completed after detach or after
      // another session replaced this connectionId.
      this.assertConnectionAttached(connection);

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
          subscription,
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
      this.assertConnectionAttached(connection);
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
      consumerCount: subscription.consumerRefs.length,
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
        consumerCount: subscription.consumerRefs.length,
      };
    }
    if (existing) await this.closeSession(subscription.subscriptionId);

    const current = await context.store.getMcpClientState(
      connection.connectionId,
      subscription.eventName,
      subscription.arguments,
    );
    let accepted = 0;

    const onEvent = async (raw) => {
      if (!this.isConnectionAttached(connection)) return;
      const receipt = await this.ingestOccurrence(
        connection,
        context,
        subscription,
        raw,
      );
      if (!this.isConnectionAttached(connection)) return;
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
      if (!this.isConnectionAttached(connection)) return;
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
      if (!this.isConnectionAttached(connection)) return;
      this.lastErrors.set(
        connection.connectionId,
        error instanceof Error ? error.message : String(error),
      );
      void this.observability?.emit({
        event: 'ei.source.delivery_failed',
        level: 'warn',
        scopeId: connection.scopeId,
        connectionId: connection.connectionId,
        serverId: connection.serverId,
        eventName: subscription.eventName,
        error,
      });
    };

    const onTerminated = async (detail) => {
      if (!this.isConnectionAttached(connection)) return;
      this.deliverySessions.delete(subscription.subscriptionId);
      if (detail) {
        this.lastErrors.set(
          connection.connectionId,
          typeof detail === 'string' ? detail : JSON.stringify(detail),
        );
      }
      void this.observability?.emit({
        event: 'ei.source.delivery_terminated',
        level: detail ? 'warn' : 'debug',
        scopeId: connection.scopeId,
        connectionId: connection.connectionId,
        serverId: connection.serverId,
        eventName: subscription.eventName,
        status: 'terminated',
      });
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

    // A stream subscription can finish opening after the host revokes its
    // connection. Close the orphan immediately; do not install a session or
    // persist cursor metadata after revocation.
    if (!this.isConnectionAttached(connection)) {
      try {
        if (typeof handle === 'function') await handle();
        else if (typeof handle?.close === 'function') await handle.close();
        else if (typeof handle?.cancel === 'function') await handle.cancel();
        else if (typeof handle?.unsubscribe === 'function') await handle.unsubscribe();
      } catch {
        // Orphan cleanup is best-effort; ingress remains fenced above.
      }
      return {
        subscriptionId: subscription.subscriptionId,
        eventName: subscription.eventName,
        delivery,
        status: 'detached',
        accepted: 0,
        consumerCount: subscription.consumerRefs.length,
      };
    }

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
      consumerCount: subscription.consumerRefs.length,
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
    this.assertConnectionAttached(connection);
    let descriptors = this.descriptors.get(connectionId);
    if (!descriptors) {
      descriptors = await this.discoverConnection(connectionId);
    }

    const desired = await this.desiredSubscriptions(connection, context);
    const desiredIds = new Set(desired.keys());
    const results = [];

    for (const subscription of desired.values()) {
      this.assertConnectionAttached(connection);
      const delivery = chooseDelivery(connection, subscription.descriptor);
      if (!delivery) {
        results.push({
          subscriptionId: subscription.subscriptionId,
          eventName: subscription.eventName,
          status: 'delivery_not_supported',
          delivery: null,
          accepted: 0,
          consumerCount: subscription.consumerRefs.length,
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
        await this.observability?.emit({
          event: 'ei.source.poll_failed',
          level: 'warn',
          scopeId: connection.scopeId,
          connectionId: connection.connectionId,
          serverId: connection.serverId,
          error,
        });
        results.push({
          connectionId: connection.connectionId,
          error: message,
        });
      }
    }
    return results;
  }

  async nextDelay(connection) {
    const context = this.scopeContexts.get(
      `${connection.connectionId}::${connection.scopeId}`,
    );
    if (!context) return connection.pollIntervalMs;
    const states = await context.store.listMcpClientStates(
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
        await this.observability?.emit({
          event: 'ei.source.poll_failed',
          level: 'warn',
          scopeId: connection.scopeId,
          connectionId: connection.connectionId,
          serverId: connection.serverId,
          error,
        });
      } finally {
        if (
          this.started &&
          this.connections.get(connection.connectionId) === connection
        ) {
          this.scheduleConnection(
            connection,
            await this.nextDelay(connection),
          );
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

  async status() {
    return Promise.all([...this.connections.values()].map(async (connection) => {
      const context = this.scopeContexts.get(
        `${connection.connectionId}::${connection.scopeId}`,
      );
      const store = context?.store ?? this.store;
      const states = await store.listMcpClientStates(connection.connectionId);
      const desired = context
        ? await this.desiredSubscriptions(connection, context)
        : new Map();
      return {
        connectionId: connection.connectionId,
        scopeId: connection.scopeId,
        serverId: connection.serverId,
        hostManaged: true,
        extensionId:
          this.profiles.get(connection.connectionId)?.extensionId ??
          MCP_EVENTS_EXTENSION_ID,
        compatibilityProfile:
          this.profiles.get(connection.connectionId)?.id ??
          connection.compatibilityProfile,
        events: (this.descriptors.get(connection.connectionId) || []).map(
          (event) => ({
            name: event.name,
            delivery: event.delivery,
            subscriptions: states
              .filter((state) => state.eventName === event.name)
              .map((state) => ({
                subscriptionId: state.subscriptionId,
                arguments: state.arguments ?? {},
                consumerCount:
                  desired.get(state.subscriptionId)?.consumerRefs.length ?? 0,
                delivery: state.deliveryMode,
                cursor: state.cursor,
                nextPollAt: state.nextPollAt ?? null,
                truncated: state.truncated ?? false,
              })),
          }),
        ),
        error: this.lastErrors.get(connection.connectionId) ?? null,
      };
    }));
  }
}
