import * as z from 'zod/v4';
import {
  McpEventOccurrenceSchema,
} from '../../dist/src/intelligenceProtocol/index.js';

const EVENTS_CAPABILITY = 'io.modelcontextprotocol.experimental/events';
const UnknownResultSchema = z.unknown();

function assertObject(value, message) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(message);
  }
  return value;
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

  return {
    connectionId,
    serverId: String(connection.serverId || `host-mcp:${connectionId}`),
    request: connection.request,
    identity: connection.identity ?? connection.request,
    enabled: connection.enabled !== false,
    pollIntervalMs: normalizePositiveInteger(
      connection.pollIntervalMs,
      5000,
      1000,
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
  };
}

/**
 * Adapt an MCP client that is already connected and authorized by the host.
 *
 * Event Intelligence never receives the provider URL, OAuth token, API key,
 * or transport. It reuses the host's existing client instance.
 */
export function createHostMcpEventsConnection({
  connectionId,
  serverId,
  client,
  request,
  enabled = true,
  pollIntervalMs = 5000,
  maxEvents = 100,
} = {}) {
  const directRequest =
    typeof request === 'function'
      ? request
      : client && typeof client.request === 'function'
        ? async (method, params) => {
            if (
              method === 'server/discover' &&
              typeof client.getServerCapabilities === 'function'
            ) {
              const capabilities = client.getServerCapabilities();
              if (capabilities) return { capabilities };
            }

            const message = {
              method,
              ...(params === undefined ? {} : { params }),
            };

            // Events is currently an experimental/custom surface, so the
            // official SDK requires an explicit result schema for those calls.
            if (method === 'server/discover') {
              return client.request(message);
            }
            return client.request(message, UnknownResultSchema);
          }
        : null;

  return normalizeConnection({
    connectionId,
    serverId,
    request: directRequest,
    identity: client ?? request ?? directRequest,
    enabled,
    pollIntervalMs,
    maxEvents,
  });
}

function schemaTypes(schema) {
  if (!schema || typeof schema !== 'object') return [];
  if (Array.isArray(schema.type)) return schema.type.map(String);
  return schema.type ? [String(schema.type)] : [];
}

export function assertJsonSchemaValue(schema, value, path = '$') {
  if (!schema || typeof schema !== 'object') return;

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    throw new Error(`MCP event payload violates schema at ${path}: value not in enum`);
  }

  const types = schemaTypes(schema);
  if (types.length) {
    const matches = types.some((type) => {
      if (type === 'null') return value === null;
      if (type === 'array') return Array.isArray(value);
      if (type === 'object') return value !== null && !Array.isArray(value) && typeof value === 'object';
      if (type === 'integer') return Number.isInteger(value);
      if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
      return typeof value === type;
    });
    if (!matches) {
      throw new Error(
        `MCP event payload violates schema at ${path}: expected ${types.join('|')}`,
      );
    }
  }

  if (value && !Array.isArray(value) && typeof value === 'object') {
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
      if (!(key in value)) {
        throw new Error(
          `MCP event payload violates schema at ${path}: missing required property ${key}`,
        );
      }
    }
    const properties = schema.properties && typeof schema.properties === 'object'
      ? schema.properties
      : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) {
        assertJsonSchemaValue(childSchema, value[key], `${path}.${key}`);
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) =>
      assertJsonSchemaValue(schema.items, item, `${path}[${index}]`)
    );
  }
}

export class McpEventsClientManager {
  constructor({
    store,
    compositeEventConsumer,
    registerEventSource,
    connections = [],
    now = () => new Date(),
  }) {
    this.store = store;
    this.compositeEventConsumer = compositeEventConsumer;
    this.registerEventSource = registerEventSource;
    this.connections = new Map();
    this.now = now;
    this.descriptors = new Map();
    this.intervals = new Map();
    this.lastErrors = new Map();
    this.started = false;

    for (const connection of connections) {
      this.addConnection(connection);
    }
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
      this.scheduleConnection(connection);
    }
    return {
      connectionId: connection.connectionId,
      events,
    };
  }

  async detachConnection(connectionId) {
    const timer = this.intervals.get(connectionId);
    if (timer) clearInterval(timer);
    this.intervals.delete(connectionId);
    this.descriptors.delete(connectionId);
    this.lastErrors.delete(connectionId);

    const removed = this.connections.delete(connectionId);
    if (removed) {
      const sources = this.store.listEventSources({ connectionIds: [connectionId] });
      for (const source of sources) {
        if (source.enabled === false) continue;
        await this.registerEventSource({
          ...source,
          enabled: false,
        });
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
      throw new Error(`Unknown host-managed MCP Events connection: ${connectionId}`);
    }

    const discover = await this.rpc(connection, 'server/discover');
    const capabilities = discover?.capabilities ?? {};
    const experimental = capabilities?.experimental?.[EVENTS_CAPABILITY];
    const extension = capabilities?.extensions?.[EVENTS_CAPABILITY];
    const standardish = capabilities?.events;
    if (!experimental && !extension && !standardish) {
      const error = new Error(
        `MCP server ${connectionId} does not advertise Events capability`,
      );
      error.code = 'MCP_EVENTS_CAPABILITY_UNAVAILABLE';
      throw error;
    }

    const listed = await this.rpc(connection, 'events/list', {});
    if (!Array.isArray(listed?.events)) {
      throw new Error(`MCP server ${connectionId} returned invalid events/list`);
    }

    const descriptors = [];
    for (const raw of listed.events) {
      const descriptor = assertObject(raw, 'Invalid MCP event descriptor');
      const name = String(descriptor.name || '');
      if (!name) throw new Error('MCP event descriptor requires name');
      const delivery = Array.isArray(descriptor.delivery)
        ? descriptor.delivery.map(String)
        : ['poll'];
      const normalized = {
        name,
        description: String(descriptor.description || ''),
        delivery,
        inputSchema:
          descriptor.inputSchema && typeof descriptor.inputSchema === 'object'
            ? descriptor.inputSchema
            : {},
        payloadSchema:
          descriptor.payloadSchema && typeof descriptor.payloadSchema === 'object'
            ? descriptor.payloadSchema
            : {},
      };
      descriptors.push(normalized);

      const sourceId = `mcp:${connection.connectionId}:${name}`;
      const existing = this.store.listEventSources()
        .find((source) => source.sourceId === sourceId);
      const same =
        existing &&
        existing.enabled !== false &&
        existing.connectionId === connection.connectionId &&
        existing.serverId === connection.serverId &&
        existing.eventName === name &&
        JSON.stringify(existing.delivery) === JSON.stringify(delivery) &&
        JSON.stringify(existing.inputSchema || {}) === JSON.stringify(normalized.inputSchema) &&
        JSON.stringify(existing.payloadSchema || {}) === JSON.stringify(normalized.payloadSchema);

      if (!same) {
        await this.registerEventSource({
          sourceId,
          connectionId: connection.connectionId,
          serverId: connection.serverId,
          eventName: name,
          description: normalized.description,
          delivery,
          inputSchema: normalized.inputSchema,
          payloadSchema: normalized.payloadSchema,
          enabled: true,
          experimental: Boolean(experimental || extension),
          metadata: {
            transport: 'host-managed-mcp',
            hostManaged: true,
          },
        });
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
          status: 'error',
          error: message,
        });
      }
    }
    return results;
  }

  async pollSource(connection, descriptor) {
    if (!descriptor.delivery.includes('poll')) {
      return { eventName: descriptor.name, status: 'delivery_not_supported', accepted: 0 };
    }

    const current = this.store.getMcpClientState(
      connection.connectionId,
      descriptor.name,
    );

    try {
      const result = await this.rpc(connection, 'events/poll', {
        name: descriptor.name,
        arguments: {},
        cursor: current?.cursor ?? null,
        maxEvents: connection.maxEvents,
      });

      if (typeof result?.cursor !== 'string' || !Array.isArray(result.events)) {
        throw new Error(
          `MCP server ${connection.connectionId} returned invalid events/poll`,
        );
      }

      let accepted = 0;
      let lastEventAt = current?.lastEventAt;
      for (const raw of result.events) {
        const occurrence = McpEventOccurrenceSchema.parse(raw);
        if (occurrence.name !== descriptor.name) {
          throw new Error(
            `MCP event name mismatch: expected ${descriptor.name}, got ${occurrence.name}`,
          );
        }
        assertJsonSchemaValue(descriptor.payloadSchema, occurrence.data);

        const receipt = await this.store.appendMcpOccurrence(
          connection.serverId,
          occurrence,
        );
        if (!receipt.accepted) continue;

        accepted += 1;
        lastEventAt = occurrence.timestamp;
        await this.compositeEventConsumer.ingestMcpOccurrence({
          event: occurrence,
          serverId: connection.serverId,
          provider: 'mcp',
          traceId: `mcp:${connection.serverId}:${occurrence.eventId}`,
        });
      }

      await this.store.putMcpClientState({
        connectionId: connection.connectionId,
        serverId: connection.serverId,
        eventName: descriptor.name,
        cursor: result.cursor,
        ...(lastEventAt ? { lastEventAt } : {}),
      });
      this.lastErrors.delete(connection.connectionId);

      return {
        eventName: descriptor.name,
        status: 'ok',
        accepted,
        cursor: result.cursor,
        hasMore: result.hasMore === true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastErrors.set(connection.connectionId, message);
      await this.store.putMcpClientState({
        connectionId: connection.connectionId,
        serverId: connection.serverId,
        eventName: descriptor.name,
        cursor: current?.cursor ?? null,
        lastError: message,
      });
      throw error;
    }
  }

  async pollConnection(connectionId) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(`Unknown host-managed MCP Events connection: ${connectionId}`);
    }

    let descriptors = this.descriptors.get(connectionId);
    if (!descriptors) {
      descriptors = await this.discoverConnection(connectionId);
    }

    const results = [];
    for (const descriptor of descriptors) {
      results.push(await this.pollSource(connection, descriptor));
    }
    return results;
  }

  async pollAll() {
    const results = [];
    for (const connection of this.connections.values()) {
      try {
        results.push({
          connectionId: connection.connectionId,
          results: await this.pollConnection(connection.connectionId),
        });
      } catch (error) {
        results.push({
          connectionId: connection.connectionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  scheduleConnection(connection) {
    if (this.intervals.has(connection.connectionId)) return;
    const timer = setInterval(() => {
      this.pollConnection(connection.connectionId).catch((error) => {
        console.error(JSON.stringify({
          message: 'host_mcp_events_poll_error',
          connectionId: connection.connectionId,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    }, connection.pollIntervalMs);
    timer.unref?.();
    this.intervals.set(connection.connectionId, timer);
  }

  start() {
    this.started = true;
    for (const connection of this.connections.values()) {
      this.scheduleConnection(connection);
    }
  }

  stop() {
    this.started = false;
    for (const timer of this.intervals.values()) clearInterval(timer);
    this.intervals.clear();
  }

  status() {
    return [...this.connections.values()].map((connection) => ({
      connectionId: connection.connectionId,
      serverId: connection.serverId,
      hostManaged: true,
      events: (this.descriptors.get(connection.connectionId) || [])
        .map((event) => ({
          name: event.name,
          delivery: event.delivery,
          cursor: this.store.getMcpClientState(
            connection.connectionId,
            event.name,
          )?.cursor ?? null,
        })),
      error: this.lastErrors.get(connection.connectionId) ?? null,
    }));
  }
}
