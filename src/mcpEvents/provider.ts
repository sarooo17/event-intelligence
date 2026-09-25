import {
  McpEventOccurrenceSchema,
} from '../intelligenceProtocol/schemas.js';
import type {
  EventDescriptor,
  EventOccurrence,
  JsonRpcRequest,
  JsonRpcResponse,
} from '../protocol/types.js';

export const MCP_EVENTS_EXTENSION_ID = 'io.modelcontextprotocol/events' as const;
export const MCP_EVENTS_CAPABILITY_KEY = MCP_EVENTS_EXTENSION_ID;

export const MCP_EVENTS_CAPABILITY = Object.freeze({
  listChanged: false,
});

export const MCP_EVENTS_ERROR = Object.freeze({
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
  NOT_FOUND: -32011,
  FORBIDDEN: -32012,
  RESOURCE_EXHAUSTED: -32013,
  UNSUPPORTED: -32014,
  CALLBACK_ENDPOINT_ERROR: -32015,
});

export class McpEventsProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpEventsProtocolError';
    this.code = code;
    this.data = data;
  }
}

export interface ProviderPollRequest<TContext = unknown> {
  name: string;
  arguments: Record<string, unknown>;
  cursor: string | null;
  maxAgeMs?: number;
  maxEvents: number;
  context?: TContext;
}

export interface ProviderPollResult {
  events: EventOccurrence[];
  cursor: string | null;
  truncated?: boolean;
  hasMore?: boolean;
  nextPollMs?: number;
}

export interface McpProviderEvent<TContext = unknown> {
  descriptor: EventDescriptor;
  poll: (
    request: ProviderPollRequest<TContext>,
  ) => ProviderPollResult | Promise<ProviderPollResult>;
}

export interface CreateMcpEventsProviderOptions<TContext = unknown> {
  events: McpProviderEvent<TContext>[];
  listPageSize?: number;
}

const ALLOWED_DELIVERY = new Set(['poll', 'push', 'webhook']);
const LIST_CURSOR_PREFIX = 'mcp-events-list-v1:';

function invalidParams(message: string, data?: unknown): never {
  throw new McpEventsProtocolError(
    MCP_EVENTS_ERROR.INVALID_PARAMS,
    message,
    data,
  );
}

function assertRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    invalidParams(message);
  }
  return value as Record<string, unknown>;
}

function optionalFiniteNumber(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    invalidParams(`${name} must be a non-negative finite number`);
  }
  return value;
}

function normalizeDescriptor(input: EventDescriptor): EventDescriptor {
  const raw = assertRecord(input, 'MCP event descriptor must be an object');
  const name = String(raw.name ?? '').trim();
  if (!name) invalidParams('MCP event descriptor requires name');

  const deliveryRaw = Array.isArray(raw.delivery) ? raw.delivery : ['poll'];
  const delivery = deliveryRaw.map((entry) => String(entry));
  if (
    delivery.length === 0 ||
    delivery.some((entry) => !ALLOWED_DELIVERY.has(entry))
  ) {
    invalidParams(`MCP event descriptor ${name} has invalid delivery modes`);
  }

  // createMcpEventsProvider is the poll-backed provider adapter. Hosts may
  // consume push/webhook sources through the host delivery hooks, but a server
  // using this adapter must expose poll for the check-since-cursor callback.
  if (!delivery.includes('poll')) {
    invalidParams(
      `MCP provider event ${name} must advertise poll delivery`,
    );
  }

  const inputSchema =
    raw.inputSchema === undefined
      ? {}
      : assertRecord(
          raw.inputSchema,
          `MCP event descriptor ${name} inputSchema must be an object`,
        );
  const payloadSchema =
    raw.payloadSchema === undefined
      ? {}
      : assertRecord(
          raw.payloadSchema,
          `MCP event descriptor ${name} payloadSchema must be an object`,
        );
  const meta =
    raw._meta === undefined
      ? undefined
      : assertRecord(
          raw._meta,
          `MCP event descriptor ${name} _meta must be an object`,
        );

  return {
    name,
    description: String(raw.description ?? ''),
    delivery: delivery as EventDescriptor['delivery'],
    inputSchema,
    payloadSchema,
    ...(meta ? { _meta: meta } : {}),
  };
}

function schemaTypes(schema: Record<string, unknown>): string[] {
  if (Array.isArray(schema.type)) {
    return schema.type.map((entry) => String(entry));
  }
  return schema.type === undefined ? [] : [String(schema.type)];
}

export function assertJsonSchemaValue(
  schemaInput: Record<string, unknown>,
  value: unknown,
  path = '$',
): void {
  const schema = assertRecord(schemaInput, `Invalid JSON Schema at ${path}`);

  if (
    Object.prototype.hasOwnProperty.call(schema, 'const') &&
    !Object.is(schema.const, value)
  ) {
    throw new Error(
      `MCP event value violates schema at ${path}: const mismatch`,
    );
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry) => Object.is(entry, value))
  ) {
    throw new Error(
      `MCP event value violates schema at ${path}: value not in enum`,
    );
  }

  const types = schemaTypes(schema);
  if (types.length > 0) {
    const matches = types.some((type) => {
      if (type === 'null') return value === null;
      if (type === 'array') return Array.isArray(value);
      if (type === 'object') {
        return value !== null && !Array.isArray(value) && typeof value === 'object';
      }
      if (type === 'integer') return Number.isInteger(value);
      if (type === 'number') {
        return typeof value === 'number' && Number.isFinite(value);
      }
      if (type === 'string') return typeof value === 'string';
      if (type === 'boolean') return typeof value === 'boolean';
      return false;
    });
    if (!matches) {
      throw new Error(
        `MCP event value violates schema at ${path}: expected ${types.join('|')}`,
      );
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      throw new Error(
        `MCP event value violates schema at ${path}: string too short`,
      );
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      throw new Error(
        `MCP event value violates schema at ${path}: string too long`,
      );
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      throw new Error(
        `MCP event value violates schema at ${path}: below minimum`,
      );
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      throw new Error(
        `MCP event value violates schema at ${path}: above maximum`,
      );
    }
  }

  if (value !== null && !Array.isArray(value) && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required)
      ? schema.required.map((entry) => String(entry))
      : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        throw new Error(
          `MCP event value violates schema at ${path}: missing required property ${key}`,
        );
      }
    }

    const properties =
      schema.properties &&
      !Array.isArray(schema.properties) &&
      typeof schema.properties === 'object'
        ? (schema.properties as Record<string, unknown>)
        : {};

    for (const [key, childSchema] of Object.entries(properties)) {
      if (
        Object.prototype.hasOwnProperty.call(record, key) &&
        childSchema &&
        !Array.isArray(childSchema) &&
        typeof childSchema === 'object'
      ) {
        assertJsonSchemaValue(
          childSchema as Record<string, unknown>,
          record[key],
          `${path}.${key}`,
        );
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          throw new Error(
            `MCP event value violates schema at ${path}: unexpected property ${key}`,
          );
        }
      }
    }
  }

  if (
    Array.isArray(value) &&
    schema.items &&
    !Array.isArray(schema.items) &&
    typeof schema.items === 'object'
  ) {
    value.forEach((entry, index) =>
      assertJsonSchemaValue(
        schema.items as Record<string, unknown>,
        entry,
        `${path}[${index}]`,
      ),
    );
  }
}

function normalizePollParams(
  paramsInput: unknown,
): Omit<ProviderPollRequest<unknown>, 'context'> {
  const params = assertRecord(
    paramsInput ?? {},
    'events/poll params must be an object',
  );
  const name = String(params.name ?? '').trim();
  if (!name) invalidParams('events/poll requires name');

  const cursor =
    params.cursor === undefined || params.cursor === null
      ? null
      : String(params.cursor);

  const argumentsValue =
    params.arguments === undefined
      ? {}
      : assertRecord(
          params.arguments,
          'events/poll arguments must be an object',
        );

  const maxAgeMs = optionalFiniteNumber(params.maxAgeMs, 'maxAgeMs');
  const maxEventsRaw = params.maxEvents ?? 50;
  if (
    typeof maxEventsRaw !== 'number' ||
    !Number.isInteger(maxEventsRaw) ||
    maxEventsRaw < 1 ||
    maxEventsRaw > 500
  ) {
    invalidParams('maxEvents must be an integer between 1 and 500');
  }

  return {
    name,
    arguments: argumentsValue,
    cursor,
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
    maxEvents: maxEventsRaw,
  };
}

function encodeListCursor(offset: number): string {
  return `${LIST_CURSOR_PREFIX}${offset}`;
}

function decodeListCursor(value: unknown): number {
  if (typeof value !== 'string' || !value.startsWith(LIST_CURSOR_PREFIX)) {
    invalidParams('events/list cursor is invalid');
  }
  const offset = Number(value.slice(LIST_CURSOR_PREFIX.length));
  if (!Number.isInteger(offset) || offset < 0) {
    invalidParams('events/list cursor is invalid');
  }
  return offset;
}

export class McpEventsProvider<TContext = unknown> {
  private readonly events = new Map<string, McpProviderEvent<TContext>>();
  private readonly listPageSize: number;

  constructor(options: CreateMcpEventsProviderOptions<TContext>) {
    if (!options || !Array.isArray(options.events)) {
      throw new Error('MCP Events provider requires events[]');
    }

    for (const input of options.events) {
      if (!input || typeof input.poll !== 'function') {
        throw new Error('MCP provider event requires poll()');
      }
      const descriptor = normalizeDescriptor(input.descriptor);
      if (this.events.has(descriptor.name)) {
        throw new Error(`Duplicate MCP provider event: ${descriptor.name}`);
      }
      this.events.set(descriptor.name, {
        descriptor,
        poll: input.poll,
      });
    }

    const pageSize = options.listPageSize ?? 100;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
      throw new Error('MCP Events listPageSize must be between 1 and 1000');
    }
    this.listPageSize = pageSize;
  }

  canHandle(method: string): boolean {
    return method === 'events/list' || method === 'events/poll';
  }

  listEvents(paramsInput?: unknown): {
    events: EventDescriptor[];
    nextCursor?: string;
  } {
    const params =
      paramsInput === undefined
        ? {}
        : assertRecord(paramsInput, 'events/list params must be an object');
    const offset =
      params.cursor === undefined || params.cursor === null
        ? 0
        : decodeListCursor(params.cursor);
    const all = [...this.events.values()].map(({ descriptor }) => descriptor);
    if (offset > all.length) invalidParams('events/list cursor is out of range');
    const events = all.slice(offset, offset + this.listPageSize);
    const nextOffset = offset + events.length;
    return {
      events,
      ...(nextOffset < all.length
        ? { nextCursor: encodeListCursor(nextOffset) }
        : {}),
    };
  }

  async handleRequest(
    request: JsonRpcRequest,
    context?: TContext,
  ): Promise<JsonRpcResponse> {
    try {
      switch (request.method) {
        case 'events/list':
          return this.ok(request.id, this.listEvents(request.params));

        case 'events/poll':
          return this.ok(
            request.id,
            await this.poll(request.params, context),
          );

        default:
          return this.error(
            request.id,
            MCP_EVENTS_ERROR.METHOD_NOT_FOUND,
            `Method not found: ${request.method}`,
          );
      }
    } catch (error) {
      if (error instanceof McpEventsProtocolError) {
        return this.error(request.id, error.code, error.message, error.data);
      }
      return this.error(
        request.id,
        MCP_EVENTS_ERROR.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Internal error',
      );
    }
  }

  private async poll(
    paramsInput: unknown,
    context?: TContext,
  ): Promise<ProviderPollResult> {
    const params = normalizePollParams(paramsInput);
    const registered = this.events.get(params.name);
    if (!registered) {
      throw new McpEventsProtocolError(
        MCP_EVENTS_ERROR.NOT_FOUND,
        `Unknown event: ${params.name}`,
        { kind: 'event' },
      );
    }

    try {
      assertJsonSchemaValue(
        registered.descriptor.inputSchema,
        params.arguments,
      );
    } catch (error) {
      throw new McpEventsProtocolError(
        MCP_EVENTS_ERROR.INVALID_PARAMS,
        error instanceof Error ? error.message : 'Invalid event arguments',
      );
    }

    const rawResult = await registered.poll({
      ...params,
      context,
    });
    if (!rawResult || Array.isArray(rawResult) || typeof rawResult !== 'object') {
      throw new Error(
        `MCP provider ${params.name} returned invalid poll result`,
      );
    }
    const result = rawResult as unknown as Record<string, unknown>;

    const cursor =
      result.cursor === null
        ? null
        : typeof result.cursor === 'string'
          ? result.cursor
          : undefined;
    if (cursor === undefined) {
      throw new Error(
        `MCP provider ${params.name} returned poll result without string|null cursor`,
      );
    }
    if (!Array.isArray(result.events)) {
      throw new Error(
        `MCP provider ${params.name} returned poll result without events[]`,
      );
    }
    if (result.events.length > params.maxEvents) {
      throw new Error(
        `MCP provider ${params.name} returned more than maxEvents=${params.maxEvents}`,
      );
    }

    const events = result.events.map((raw) => {
      const parsed = McpEventOccurrenceSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `MCP provider ${params.name} returned invalid EventOccurrence: ${parsed.error.message}`,
        );
      }
      if (parsed.data.name !== params.name) {
        throw new Error(
          `MCP provider event name mismatch: expected ${params.name}, got ${parsed.data.name}`,
        );
      }
      assertJsonSchemaValue(
        registered.descriptor.payloadSchema,
        parsed.data.data,
      );
      return parsed.data;
    });

    const truncated = result.truncated ?? false;
    const hasMore = result.hasMore ?? false;
    if (typeof truncated !== 'boolean' || typeof hasMore !== 'boolean') {
      throw new Error(
        `MCP provider ${params.name} returned invalid pagination flags`,
      );
    }

    const nextPollMs = result.nextPollMs ?? 5000;
    if (
      typeof nextPollMs !== 'number' ||
      !Number.isInteger(nextPollMs) ||
      nextPollMs < 0 ||
      nextPollMs > 300000
    ) {
      throw new Error(
        `MCP provider ${params.name} returned invalid nextPollMs`,
      );
    }

    return {
      events,
      cursor,
      truncated,
      hasMore,
      nextPollMs,
    };
  }

  private ok(id: string | number, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private error(
    id: string | number,
    code: number,
    message: string,
    data?: unknown,
  ): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    };
  }
}

export function createMcpEventsProvider<TContext = unknown>(
  options: CreateMcpEventsProviderOptions<TContext>,
): McpEventsProvider<TContext> {
  return new McpEventsProvider(options);
}

export {
  ExperimentalMcpEventsServer,
  decodeMcpEventCursor,
  encodeMcpEventCursor,
} from './server.js';

export type {
  McpEventOccurrenceStore,
  PersistedMcpOccurrence,
  PollEventsParams,
  PollEventsResult,
  RegisteredMcpEvent,
} from './server.js';
