import { isProxy } from 'node:util/types';

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|token|payload|instruction|context|evidence|body|content|data)/i;

export const EI_OBSERVABILITY_SCHEMA_VERSION = '1';

// Call only scalar conversion: executing custom toString during telemetry
// redaction can have side effects and leak secrets before reaching the sink.
function safeScalar(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '[untrusted value]';
}

function ownData(input, key) {
  if (!input || typeof input !== 'object' || isProxy(input)) return undefined;
  const property = Object.getOwnPropertyDescriptor(input, key);
  return property && Object.hasOwn(property, 'value')
    ? property.value
    : undefined;
}

function errorData(error, key) {
  if (!error || typeof error !== 'object' || isProxy(error)) return undefined;
  let current = error;
  // Read inherited plain Error.name without evaluating custom accessors.
  for (let i = 0; i < 4 && current; i++) {
    if (isProxy(current)) return undefined;
    const property = Object.getOwnPropertyDescriptor(current, key);
    if (property) {
      return Object.hasOwn(property, 'value') ? property.value : undefined;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function truncate(value, max = 1000) {
  const text = safeScalar(value).normalize('NFKC')
    .replace(/Bearer[\s\u0085]+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(
      /((?:["']?)(?:api[_-]?key|authorization|password|secret|token)(?:["']?)[\s\u0085]*[=:][\s\u0085]*(?:["']?))[^"'\s\u0085,;}\]]+/giu,
      '$1[redacted]',
    );
  return text.length > max ? text.slice(0, max) + '…' : text;
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
  if (value == null || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') return truncate(value);
  if (typeof value !== 'object' || isProxy(value)) return '[untrusted value]';
  if (depth >= 3) return '[truncated]';

  if (value instanceof Error) return serializeObservabilityError(value);

  if (Array.isArray(value)) {
    const result = [];
    for (let i = 0; i < Math.min(value.length, 20); i++) {
      const slot = Object.getOwnPropertyDescriptor(value, String(i));
      result.push(slot && Object.hasOwn(slot, 'value')
        ? sanitize(slot.value, depth + 1)
        : '[untrusted value]');
    }
    return result;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return '[untrusted value]';
  const result = {};
  for (const key of Reflect.ownKeys(value).slice(0, 40)) {
    if (typeof key !== 'string' || SENSITIVE_KEY.test(key)) continue;
    const slot = Object.getOwnPropertyDescriptor(value, key);
    if (!slot || !slot.enumerable || !Object.hasOwn(slot, 'value')) continue;
    const sanitized = sanitize(slot.value, depth + 1);
    if (sanitized !== undefined) {
      Object.defineProperty(result, key, {
        value: sanitized, enumerable: true, writable: true, configurable: true,
      });
    }
  }
  return result;
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
  if (error && typeof error === 'object' && !isProxy(error) &&
      error instanceof Error) {
    const code = errorData(error, 'code');
    return Object.freeze({
      name: truncate(errorData(error, 'name') ?? 'Error', 120),
      message: truncate(errorData(error, 'message') ?? '[untrusted error]'),
      ...(code == null ? {} : { code: truncate(code, 200) }),
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
      // Only own data descriptors are allowed. Top-level getters and Proxy
      // traps must never run as part of observability or redaction.
      const field = name => ownData(input, name);
      const rawEvent = field('event');
      const event = typeof rawEvent === 'string' ? rawEvent.trim() : '';
      if (!event.startsWith('ei.')) {
        throw new Error('observability event must use the ei.* namespace');
      }

      const rawLevel = field('level');
      const level = rawLevel == null ? 'info'
        : typeof rawLevel === 'string' ? rawLevel.toLowerCase() : '';
      if (!LEVELS.has(level)) {
        throw new Error('unsupported observability level');
      }

      const attempt = field('attempt');
      const numericAttempt = typeof attempt === 'number' ? attempt
        : typeof attempt === 'string' && attempt.trim() ? Number(attempt) : null;
      const metadata = field('metadata');
      const timestamp = field('timestamp');
      const record = {
        schema: 'event-intelligence.observability.v' + EI_OBSERVABILITY_SCHEMA_VERSION,
        timestamp: timestamp ? dimension(timestamp) : now().toISOString(),
        level,
        event: dimension(event),
        component: dimension(field('component') ?? component),
        ...(field('traceId') ? { traceId: dimension(field('traceId')) } : {}),
        ...(field('scopeId') ? { scopeId: dimension(field('scopeId')) } : {}),
        ...(field('triggerId') ? { triggerId: dimension(field('triggerId')) } : {}),
        ...(field('matchId') ? { matchId: dimension(field('matchId')) } : {}),
        ...(field('wakeId') ? { wakeId: dimension(field('wakeId')) } : {}),
        ...(field('connectionId') ? { connectionId: dimension(field('connectionId')) } : {}),
        ...(field('serverId') ? { serverId: dimension(field('serverId')) } : {}),
        ...(field('eventName') ? { eventName: dimension(field('eventName')) } : {}),
        ...(field('status') ? { status: dimension(field('status')) } : {}),
        ...(numericAttempt !== null && Number.isFinite(numericAttempt)
          ? { attempt: numericAttempt } : {}),
        ...(field('nextAttemptAt')
          ? { nextAttemptAt: dimension(field('nextAttemptAt')) }
          : {}),
        ...(field('error')
          ? { error: serializeObservabilityError(field('error')) }
          : {}),
        ...(metadata && typeof metadata === 'object'
          ? { metadata: sanitize(metadata) }
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


/**
 * Optional dependency-free translation of already-sanitized EI observation
 * records into OpenTelemetry spans. The embedding host supplies its tracer:
 * EI does not own exporters, sampling, parent context, credentials or SDK.
 *
 * By default no tenant IDs, event payload, metadata or correlation IDs are
 * exported. Correlation IDs are opt-in, useful only for authorized sinks with
 * appropriate cardinality and data-retention policy.
 */
export function createOpenTelemetrySink(tracer, { includeCorrelations = false } = {}) {
  if (!tracer || typeof tracer.startSpan !== 'function') {
    throw new TypeError('OpenTelemetry bridge requires tracer.startSpan()');
  }
  if (typeof includeCorrelations !== 'boolean') {
    throw new TypeError('includeCorrelations must be boolean');
  }

  return Object.freeze({
    emit(record) {
      // This adapter is intended to consume createObservabilityEmitter's
      // sanitized output, never unvalidated provider/agent payloads.
      if (!record || typeof record.event !== 'string' ||
          !record.event.startsWith('ei.')) return;
      try {
        const attributes = {
          'ei.schema': dimension(record.schema ?? ''),
          'ei.level': dimension(record.level ?? ''),
          'ei.component': dimension(record.component ?? ''),
          ...(record.status ? { 'ei.status': dimension(record.status) } : {}),
          ...(Number.isFinite(record.attempt)
            ? { 'ei.attempt': record.attempt } : {}),
        };
        if (includeCorrelations) {
          // Explicit opt-in: these are already sanitized and length-bounded
          // by EI's core emitter, not arbitrarily copied from event data.
          for (const key of ['traceId', 'scopeId', 'triggerId', 'matchId', 'wakeId']) {
            if (typeof record[key] === 'string' && record[key]) {
              attributes['ei.' + key] = dimension(record[key]);
            }
          }
        }
        const span = tracer.startSpan(dimension(record.event), { attributes });
        if (span && typeof span.end === 'function') span.end();
      } catch {
        // Observability must never block or change match/wake semantics.
      }
    },
  });
}
