import {
  McpEventOccurrenceSchema,
} from '../intelligenceProtocol/schemas.js';
import type {
  EventDescriptor,
  EventOccurrence,
  JsonRpcRequest,
  JsonRpcResponse,
} from '../protocol/types.js';

export const MCP_EVENTS_CAPABILITY_KEY =
  'io.modelcontextprotocol.experimental/events' as const;

export const MCP_EVENTS_CAPABILITY = Object.freeze({
  status: 'draft',
  designDate: '2026-02-19',
  methods: ['events/list', 'events/poll'] as const,
  listChanged: false,
});

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
  cursor: string;
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
  supportedVersions?: string[];
  instructions?: string;
}

const ALLOWED_DELIVERY = new Set(['poll', 'push', 'webhook']);

function assertRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function optionalFiniteNumber(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}

function normalizeDescriptor(input: EventDescriptor): EventDescriptor {
  const raw = assertRecord(input, 'MCP event descriptor must be an object');
  const name = String(raw.name ?? '').trim();
  if (!name) throw new Error('MCP event descriptor requires name');

  const deliveryRaw = Array.isArray(raw.delivery) ? raw.delivery : ['poll'];
  const delivery = deliveryRaw.map((entry) => String(entry));
  if (
    delivery.length === 0 ||
    delivery.some((entry) => !ALLOWED_DELIVERY.has(entry))
  ) {
    throw new Error(`MCP event descriptor ${name} has invalid delivery modes`);
  }
  if (!delivery.includes('poll')) {
    throw new Error(
      `MCP provider event ${name} must advertise poll delivery in v0.1`,
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

  return {
    name,
    description: String(raw.description ?? ''),
    delivery: delivery as EventDescriptor['delivery'],
    inputSchema,
    payloadSchema,
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
      `MCP event payload violates schema at ${path}: const mismatch`,
    );
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry) => Object.is(entry, value))
  ) {
    throw new Error(
      `MCP event payload violates schema at ${path}: value not in enum`,
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
        `MCP event payload violates schema at ${path}: expected ${types.join('|')}`,
      );
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      throw new Error(
        `MCP event payload violates schema at ${path}: string too short`,
      );
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      throw new Error(
        `MCP event payload violates schema at ${path}: string too long`,
      );
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      throw new Error(
        `MCP event payload violates schema at ${path}: below minimum`,
      );
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      throw new Error(
        `MCP event payload violates schema at ${path}: above maximum`,
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
          `MCP event payload violates schema at ${path}: missing required property ${key}`,
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
            `MCP event payload violates schema at ${path}: unexpected property ${key}`,
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
  if (!name) throw new Error('events/poll requires name');

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
    throw new Error('maxEvents must be an integer between 1 and 500');
  }

  return {
    name,
    arguments: argumentsValue,
    cursor,
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
    maxEvents: maxEventsRaw,
  };
}

export class McpEventsProvider<TContext = unknown> {
  private readonly events = new Map<string, McpProviderEvent<TContext>>();
  readonly supportedVersions: string[];
  readonly instructions: string;

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

    this.supportedVersions =
      options.supportedVersions?.map(String).filter(Boolean) ?? ['2026-07-28'];
    this.instructions =
      options.instructions ??
      'Experimental MCP Events provider compatibility adapter. Events follow the Triggers & Events design sketch; this is not finalized MCP conformance.';
  }

  canHandle(method: string): boolean {
    return (
      method === 'server/discover' ||
      method === 'events/list' ||
      method === 'events/poll'
    );
  }

  listEvents(): EventDescriptor[] {
    return [...this.events.values()].map(({ descriptor }) => descriptor);
  }

  async handleRequest(
    request: JsonRpcRequest,
    context?: TContext,
  ): Promise<JsonRpcResponse> {
    try {
      switch (request.method) {
        case 'server/discover':
          return this.ok(request.id, {
            supportedVersions: this.supportedVersions,
            capabilities: {
              experimental: {
                [MCP_EVENTS_CAPABILITY_KEY]: MCP_EVENTS_CAPABILITY,
              },
            },
            instructions: this.instructions,
          });

        case 'events/list':
          return this.ok(request.id, {
            events: this.listEvents(),
          });

        case 'events/poll':
          return this.ok(
            request.id,
            await this.poll(request.params, context),
          );

        default:
          return this.error(
            request.id,
            -32601,
            `Method not found: ${request.method}`,
          );
      }
    } catch (error) {
      return this.error(
        request.id,
        -32602,
        error instanceof Error ? error.message : 'Invalid params',
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
      throw new Error(`Unknown event: ${params.name}`);
    }

    const result = assertRecord(
      await registered.poll({
        ...params,
        context,
      }),
      `MCP provider ${params.name} returned invalid poll result`,
    );

    if (typeof result.cursor !== 'string') {
      throw new Error(
        `MCP provider ${params.name} returned poll result without string cursor`,
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
      cursor: result.cursor,
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
  ): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
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
