const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|token|payload|instruction|context|evidence|body|content|data)/i;

export const EI_OBSERVABILITY_SCHEMA_VERSION = '1';

function truncate(value, max = 1000) {
  const text = String(value ?? '').normalize('NFKC')
    .replace(/Bearer[\s\u0085]+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(
      /((?:api[_-]?key|authorization|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi,
      '$1[redacted]',
    );
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Public telemetry dimensions are not trusted just because their field name
 * is approved: MCP/provider-controlled identifiers and status text can still
 * contain bearer credentials or key=value fragments.
 */
function dimension(value, max = 200) {
  return truncate(value, max);
}

function sanitize(value, depth = 0) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') return truncate(value);
  if (depth >= 3) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  }
  if (value instanceof Error) {
    return {
      name: truncate(value.name, 120),
      message: truncate(value.message),
      ...(value.code == null ? {} : { code: truncate(value.code, 200) }),
    };
  }
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      if (SENSITIVE_KEY.test(key)) continue;
      const sanitized = sanitize(item, depth + 1);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  }
  return undefined;
}

function normalizeSink(input) {
  if (input == null) return null;
  if (typeof input === 'function') return { emit: input };
  if (typeof input === 'object' && typeof input.emit === 'function') {
    return input;
  }
  throw new Error('observability must be a function or { emit(event) }');
}

export function serializeObservabilityError(error) {
  if (error instanceof Error) {
    return Object.freeze({
      name: truncate(error.name, 120),
      message: truncate(error.message),
      ...(error.code == null ? {} : { code: truncate(error.code, 200) }),
    });
  }
  return Object.freeze({ message: truncate(error) });
}

/**
 * Runtime-neutral, best-effort observability boundary.
 *
 * Async sinks are detached after invocation, so slow telemetry cannot stall
 * event processing. Sink failures are intentionally swallowed: telemetry must never
 * change Event Intelligence delivery semantics. Event payloads, continuation
 * instructions, evidence and credentials are not accepted as first-class
 * fields and sensitive keys in metadata are dropped defensively.
 */
export function createObservabilityEmitter(
  sinkInput,
  { now = () => new Date(), component = 'event-intelligence' } = {},
) {
  const sink = normalizeSink(sinkInput);

  return Object.freeze({
    enabled: Boolean(sink),
    async emit(input = {}) {
      if (!sink) return false;

      const event = String(input.event ?? '').trim();
      if (!event.startsWith('ei.')) {
        throw new Error('observability event must use the ei.* namespace');
      }

      const level = String(input.level ?? 'info').toLowerCase();
      if (!LEVELS.has(level)) {
        throw new Error(`unsupported observability level: ${level}`);
      }

      const record = {
        schema: `event-intelligence.observability.v${EI_OBSERVABILITY_SCHEMA_VERSION}`,
        timestamp: input.timestamp
          ? dimension(input.timestamp)
          : now().toISOString(),
        level,
        event: dimension(event),
        component: dimension(input.component ?? component),
        ...(input.traceId ? { traceId: dimension(input.traceId) } : {}),
        ...(input.scopeId ? { scopeId: dimension(input.scopeId) } : {}),
        ...(input.triggerId ? { triggerId: dimension(input.triggerId) } : {}),
        ...(input.matchId ? { matchId: dimension(input.matchId) } : {}),
        ...(input.wakeId ? { wakeId: dimension(input.wakeId) } : {}),
        ...(input.connectionId ? { connectionId: dimension(input.connectionId) } : {}),
        ...(input.serverId ? { serverId: dimension(input.serverId) } : {}),
        ...(input.eventName ? { eventName: dimension(input.eventName) } : {}),
        ...(input.status ? { status: dimension(input.status) } : {}),
        ...(input.attempt != null ? { attempt: Number(input.attempt) } : {}),
        ...(input.nextAttemptAt
          ? { nextAttemptAt: dimension(input.nextAttemptAt) }
          : {}),
        ...(input.error
          ? { error: serializeObservabilityError(input.error) }
          : {}),
        ...(input.metadata && typeof input.metadata === 'object'
          ? { metadata: sanitize(input.metadata) }
          : {}),
      };

      try {
        const pending = sink.emit(Object.freeze(record));
        if (pending && typeof pending.then === 'function') {
          void Promise.resolve(pending).catch(() => {});
        }
        return true;
      } catch {
        return false;
      }
    },
  });
}
