export type EventIntelligenceObservabilityLevel =
  | 'debug'
  | 'info'
  | 'warn'
  | 'error';

export interface EventIntelligenceObservabilityEvent {
  schema: 'event-intelligence.observability.v1' | string;
  timestamp: string;
  level: EventIntelligenceObservabilityLevel;
  event: `ei.${string}`;
  component: string;
  traceId?: string;
  scopeId?: string;
  triggerId?: string;
  matchId?: string;
  wakeId?: string;
  connectionId?: string;
  serverId?: string;
  eventName?: string;
  status?: string;
  attempt?: number;
  nextAttemptAt?: string;
  error?: {
    name?: string;
    code?: string;
    message: string;
  };
  metadata?: Record<string, unknown>;
}

export type EventIntelligenceObservabilitySink =
  | ((event: EventIntelligenceObservabilityEvent) => void | Promise<void>)
  | {
      emit(
        event: EventIntelligenceObservabilityEvent,
      ): void | Promise<void>;
    };

export interface EventIntelligenceObservabilityEmitter {
  readonly enabled: boolean;
  emit(input: {
    event: `ei.${string}`;
    level?: EventIntelligenceObservabilityLevel;
    timestamp?: string;
    component?: string;
    traceId?: string;
    scopeId?: string;
    triggerId?: string;
    matchId?: string;
    wakeId?: string;
    connectionId?: string;
    serverId?: string;
    eventName?: string;
    status?: string;
    attempt?: number;
    nextAttemptAt?: string;
    error?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<boolean>;
}

export const EI_OBSERVABILITY_SCHEMA_VERSION: '1';

export function serializeObservabilityError(error: unknown): Readonly<{
  name?: string;
  code?: string;
  message: string;
}>;

export function createObservabilityEmitter(
  sink?: EventIntelligenceObservabilitySink | null,
  options?: {
    now?: () => Date;
    component?: string;
  },
): EventIntelligenceObservabilityEmitter;

/** Optional host-supplied OTel tracer, with no SDK dependency or exporter. */
export interface EventIntelligenceSpan {
  end(): void;
}
export interface EventIntelligenceTracer {
  startSpan(
    name: string,
    options: { attributes: Record<string, string | number> },
  ): EventIntelligenceSpan;
}
export function createOpenTelemetrySink(
  tracer: EventIntelligenceTracer,
  options?: { includeCorrelations?: boolean },
): { readonly emit: (event: EventIntelligenceObservabilityEvent) => void };
