import { readOwnEventPath } from '../protocol/ownPath.js';
import type {
  CorrelatableEvent,
  TriggerClause,
  TriggerSourceEvent,
} from '../intelligenceProtocol/triggerSchemas.js';


function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          stableValue((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function sameSubscriptionArguments(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  return JSON.stringify(stableValue(left ?? {})) ===
    JSON.stringify(stableValue(right ?? {}));
}

function predicateMatches(
  event: CorrelatableEvent,
  predicate: TriggerClause['where'][number],
): boolean {
  const value = readOwnEventPath(event.data, predicate.path);

  switch (predicate.op) {
    case 'eq':
      return value === predicate.value;
    case 'neq':
      return value !== predicate.value;
    case 'contains':
      if (typeof value === 'string') return value.includes(String(predicate.value));
      if (Array.isArray(value)) return value.includes(predicate.value);
      return false;
    case 'startsWith':
      return typeof value === 'string' && value.startsWith(predicate.value);
    case 'endsWith':
      return typeof value === 'string' && value.endsWith(predicate.value);
    case 'regex':
      if (typeof value !== 'string') return false;
      try {
        return new RegExp(predicate.value, predicate.flags ?? '').test(value);
      } catch {
        return false;
      }
    case 'in':
      return predicate.value.includes(value as string | number | boolean);
    case 'notIn':
      return !predicate.value.includes(value as string | number | boolean);
    case 'between': {
      const [lower, upper] = predicate.value;
      if (typeof value === 'number') {
        return (
          typeof lower === 'number' &&
          typeof upper === 'number' &&
          value >= lower &&
          value <= upper
        );
      }
      if (typeof value === 'string') {
        return (
          typeof lower === 'string' &&
          typeof upper === 'string' &&
          value >= lower &&
          value <= upper
        );
      }
      return false;
    }
    case 'exists':
      return predicate.value ? value !== undefined : value === undefined;
    case 'isNull':
      return predicate.value
        ? value === null || value === undefined
        : value !== null && value !== undefined;
    case 'type':
      if (predicate.value === 'null') return value === null;
      if (predicate.value === 'array') return Array.isArray(value);
      if (predicate.value === 'object') {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
      }
      return typeof value === predicate.value;
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
  const contractVersion = readOwnEventPath(
    event.data,
    '_derived.contractVersion',
  );
  return (
    clause.event === event.name &&
    (!clause.serverId || clause.serverId === event.serverId) &&
    sameSubscriptionArguments(
      clause.arguments,
      event.subscriptionArguments,
    ) &&
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
    ...(event.receivedAt ? { receivedAt: event.receivedAt } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.serverId ? { serverId: event.serverId } : {}),
    subscriptionArguments: event.subscriptionArguments ?? {},
    ...(event.payloadHash ? { payloadHash: event.payloadHash } : {}),
    data: event.data,
  };
}

export function sameEventIdentity(
  source: Pick<
    TriggerSourceEvent,
    'sourceEventId' | 'serverId' | 'subscriptionArguments'
  >,
  event: Pick<
    CorrelatableEvent,
    'sourceEventId' | 'serverId' | 'subscriptionArguments'
  >,
): boolean {
  return (
    source.sourceEventId === event.sourceEventId &&
    (source.serverId ?? null) === (event.serverId ?? null) &&
    sameSubscriptionArguments(
      source.subscriptionArguments,
      event.subscriptionArguments,
    )
  );
}
