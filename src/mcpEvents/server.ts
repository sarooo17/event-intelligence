import type {
  EventDescriptor,
  EventOccurrence,
  JsonRpcRequest,
  JsonRpcResponse,
} from '../protocol/types.js';

export interface PersistedMcpOccurrence {
  sequence: number;
  serverId: string;
  /** Client-side durable subscription identity when this log is used by EI. */
  subscriptionId?: string | null;
  event: EventOccurrence;
}

export interface McpEventOccurrenceStore {
  latestMcpEventSequence(): number;
  listMcpOccurrencesAfter(sequence: number): PersistedMcpOccurrence[];
}

export interface RegisteredMcpEvent {
  descriptor: EventDescriptor;
  matcher: (
    args: Record<string, unknown>,
    event: EventOccurrence,
  ) => boolean;
}

export interface PollEventsParams {
  name: string;
  arguments?: Record<string, unknown>;
  cursor?: string | null;
  maxAgeMs?: number;
  maxEvents?: number;
}

export interface PollEventsResult {
  events: EventOccurrence[];
  cursor: string | null;
  truncated: boolean;
  hasMore: boolean;
  nextPollMs: number;
}

const CURSOR_PREFIX = 'mcp-events-v1:';

export function encodeMcpEventCursor(sequence: number): string {
  return `${CURSOR_PREFIX}${sequence}`;
}

export function decodeMcpEventCursor(cursor: string): number {
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new Error('Invalid MCP Events cursor');
  }
  const value = Number(cursor.slice(CURSOR_PREFIX.length));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('Invalid MCP Events cursor');
  }
  return value;
}

export class ExperimentalMcpEventsServer {
  private readonly events = new Map<string, RegisteredMcpEvent>();

  constructor(
    private readonly store: McpEventOccurrenceStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  registerEvent(event: RegisteredMcpEvent): void {
    this.events.set(event.descriptor.name, event);
  }

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      switch (request.method) {
        case 'events/list':
          return this.ok(request.id, {
            events: [...this.events.values()].map((entry) => entry.descriptor),
          });

        case 'events/poll': {
          const params = (request.params ?? {}) as PollEventsParams;
          if (!params.name || typeof params.name !== 'string') {
            return this.error(request.id, -32602, 'events/poll requires name');
          }
          if (!this.events.has(params.name)) {
            return this.error(
              request.id,
              -32011,
              `Unknown event: ${params.name}`,
              { kind: 'event' },
            );
          }
          return this.ok(request.id, this.poll(params));
        }

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

  poll(params: PollEventsParams): PollEventsResult {
    const registered = this.events.get(params.name);
    if (!registered) {
      throw new Error(`Unknown event: ${params.name}`);
    }

    const latest = this.store.latestMcpEventSequence();

    if (params.cursor === null || params.cursor === undefined) {
      return {
        events: [],
        cursor: encodeMcpEventCursor(latest),
        truncated: false,
        hasMore: false,
        nextPollMs: 5000,
      };
    }

    const start = decodeMcpEventCursor(params.cursor);
    const limit = Math.max(1, Math.min(params.maxEvents ?? 50, 500));
    const minTimestamp =
      params.maxAgeMs === undefined
        ? Number.NEGATIVE_INFINITY
        : this.now().getTime() - params.maxAgeMs;

    const candidates = this.store.listMcpOccurrencesAfter(start);
    const args = params.arguments ?? {};
    const events: EventOccurrence[] = [];
    let cursorSequence = start;
    let truncated = false;
    let stoppedIndex = candidates.length;

    for (let index = 0; index < candidates.length; index += 1) {
      const record = candidates[index]!;
      cursorSequence = record.sequence;

      if (record.event.name !== params.name) continue;

      if (Date.parse(record.event.timestamp) < minTimestamp) {
        truncated = true;
        continue;
      }

      if (!registered.matcher(args, record.event)) continue;

      events.push(record.event);
      if (events.length >= limit) {
        stoppedIndex = index + 1;
        break;
      }
    }

    const remaining = candidates.slice(stoppedIndex);
    const hasMore = remaining.some(
      (record) =>
        record.event.name === params.name &&
        Date.parse(record.event.timestamp) >= minTimestamp &&
        registered.matcher(args, record.event),
    );

    if (!hasMore && candidates.length > 0) {
      cursorSequence = candidates[candidates.length - 1]!.sequence;
    }

    return {
      events,
      cursor: encodeMcpEventCursor(cursorSequence),
      truncated,
      hasMore,
      nextPollMs: hasMore ? 0 : 5000,
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
