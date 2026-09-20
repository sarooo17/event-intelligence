import type {
  CompositeTriggerDefinition,
  CorrelatableEvent,
  TriggerClause,
  TriggerMatchRecord,
  TriggerSourceEvent,
} from '../intelligenceProtocol/triggerSchemas.js';

function getByPath(source: unknown, path: string): unknown {
  let current = source;
  for (const part of path.split('.')) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function scalarKey(value: unknown): string | null {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) return String(value);
  return null;
}

function predicateMatches(
  event: CorrelatableEvent,
  predicate: TriggerClause['where'][number],
): boolean {
  const value = getByPath(event.data, predicate.path);

  switch (predicate.op) {
    case 'eq':
      return value === predicate.value;
    case 'neq':
      return value !== predicate.value;
    case 'contains':
      if (typeof value === 'string') return value.includes(String(predicate.value));
      if (Array.isArray(value)) return value.includes(predicate.value);
      return false;
    case 'in':
      return predicate.value.includes(value as string | number | boolean);
    case 'exists':
      return predicate.value ? value !== undefined : value === undefined;
    case 'gt':
      return typeof value === 'number' && value > predicate.value;
    case 'gte':
      return typeof value === 'number' && value >= predicate.value;
    case 'lt':
      return typeof value === 'number' && value < predicate.value;
    case 'lte':
      return typeof value === 'number' && value <= predicate.value;
  }
}

export function clauseMatches(
  clause: TriggerClause,
  event: CorrelatableEvent,
): boolean {
  const contractVersion = getByPath(
    event.data,
    '_derived.contractVersion',
  );
  return (
    clause.event === event.name &&
    (!clause.serverId || clause.serverId === event.serverId) &&
    (
      !clause.contractVersion ||
      String(contractVersion ?? '') === String(clause.contractVersion)
    ) &&
    clause.where.every((predicate) => predicateMatches(event, predicate))
  );
}

export function asSourceEvent(
  clauseId: string,
  event: CorrelatableEvent,
): TriggerSourceEvent {
  return {
    clauseId,
    traceId: event.traceId,
    sourceEventId: event.sourceEventId,
    eventName: event.name,
    occurredAt: event.occurredAt,
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.serverId ? { serverId: event.serverId } : {}),
    ...(event.payloadHash ? { payloadHash: event.payloadHash } : {}),
    data: event.data,
  };
}

function clauseEvents(
  record: TriggerMatchRecord,
  ref: string,
): TriggerSourceEvent[] {
  return record.sourceEvents
    .filter((event) => event.clauseId === ref)
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}

export function expressionSatisfied(
  definition: CompositeTriggerDefinition,
  record: TriggerMatchRecord,
): boolean {
  const expression = definition.expression;

  if (expression.kind === 'allOf') {
    return expression.refs.every((ref) => clauseEvents(record, ref).length > 0);
  }

  if (expression.kind === 'anyOf') {
    return expression.refs.some((ref) => clauseEvents(record, ref).length > 0);
  }

  if (expression.kind === 'count') {
    return clauseEvents(record, expression.ref).length >= expression.atLeast;
  }

  let previous = Number.NEGATIVE_INFINITY;
  for (const ref of expression.refs) {
    const candidate = clauseEvents(record, ref)
      .find((event) => Date.parse(event.occurredAt) > previous);
    if (!candidate) return false;
    previous = Date.parse(candidate.occurredAt);
  }
  return true;
}

export function semanticSource(
  record: TriggerMatchRecord,
): Record<string, unknown> {
  const source: Record<string, unknown> = {};
  for (const event of record.sourceEvents) {
    source[event.clauseId] = event.data;
  }
  return source;
}

export function deterministicKeyForClause(
  definition: CompositeTriggerDefinition,
  clauseId: string,
  event: CorrelatableEvent,
): string | null {
  const deterministic = definition.correlation?.deterministic;
  if (!deterministic) return null;

  const field = deterministic.fields.find((item) => item.ref === clauseId);
  if (!field) return null;
  return scalarKey(getByPath(event.data, field.path));
}

export function sameEventIdentity(
  source: Pick<TriggerSourceEvent, 'sourceEventId' | 'serverId'>,
  event: Pick<CorrelatableEvent, 'sourceEventId' | 'serverId'>,
): boolean {
  return (
    source.sourceEventId === event.sourceEventId &&
    (source.serverId ?? null) === (event.serverId ?? null)
  );
}

export function matchesCorrelationKey(
  record: TriggerMatchRecord,
  key: string | null,
): boolean {
  if (record.correlationKey === null || key === null) return true;
  return record.correlationKey === key;
}
