import {
  canonicalJson,
  parseCompositeTriggerDefinition,
  parseTriggerPlanInput,
  sha256Hex,
} from '../../dist/src/intelligenceProtocol/index.js';
import { assertJsonSchemaValue } from './json-schema.mjs';

function schemaNodeAtPath(schema, path) {
  if (!schema || typeof schema !== 'object') return null;
  let node = schema;
  for (const part of String(path).split('.')) {
    const properties = node?.properties;
    if (!properties || typeof properties !== 'object' || !(part in properties)) {
      return null;
    }
    node = properties[part];
  }
  return node;
}

function sourceSummary(source) {
  return {
    sourceId: source.sourceId,
    connectionId: source.connectionId,
    serverId: source.serverId,
    eventName: source.eventName,
    description: source.description ?? null,
    delivery: source.delivery ?? [],
    inputSchema: source.inputSchema ?? {},
    payloadSchema: source.payloadSchema ?? {},
  };
}

function validateArgumentsAgainstSource(source, args) {
  const schema = source.inputSchema;
  if (!schema || typeof schema !== 'object' || Object.keys(schema).length === 0) {
    return;
  }
  try {
    assertJsonSchemaValue(schema, args ?? {});
  } catch (error) {
    throw sourceError(
      'TRIGGER_PLAN_ARGUMENTS_INVALID',
      `Subscription arguments do not match ${source.serverId}/${source.eventName}: ${error instanceof Error ? error.message : String(error)}`,
      [source],
    );
  }
}

function sourceError(code, message, sources = []) {
  const error = new Error(message);
  error.code = code;
  if (sources.length) error.sources = sources.map(sourceSummary);
  return error;
}

function validatePredicateAgainstSource(source, predicate, warnings) {
  const schema = source.payloadSchema;
  if (!schema || typeof schema !== 'object' || Object.keys(schema).length === 0) {
    warnings.push({
      code: 'SOURCE_SCHEMA_UNAVAILABLE',
      event: source.eventName,
      serverId: source.serverId,
      path: predicate.path,
      message: 'Source does not advertise a payload schema; predicate path cannot be prevalidated.',
    });
    return;
  }

  const node = schemaNodeAtPath(schema, predicate.path);
  if (!node) {
    throw sourceError(
      'TRIGGER_PLAN_FIELD_UNAVAILABLE',
      `Field ${predicate.path} is not advertised by ${source.serverId}/${source.eventName}`,
      [source],
    );
  }

  if (
    ['gt', 'gte', 'lt', 'lte'].includes(predicate.op) &&
    node?.type &&
    !['number', 'integer'].includes(node.type)
  ) {
    throw sourceError(
      'TRIGGER_PLAN_NUMERIC_FIELD_REQUIRED',
      `Predicate ${predicate.op} requires a numeric field, but ${predicate.path} is ${node.type}`,
      [source],
    );
  }
}

function expressionFor(match, refs) {
  if (typeof match === 'object' && match?.kind === 'count') {
    if (!refs.includes(match.eventId)) {
      const error = new Error(`Count match references unknown event id: ${match.eventId}`);
      error.code = 'TRIGGER_PLAN_EVENT_REF_UNKNOWN';
      throw error;
    }
    return { kind: 'count', ref: match.eventId, atLeast: match.atLeast };
  }

  if (match === 'sequence') {
    if (refs.length < 2) {
      const error = new Error('Sequence match requires at least two events');
      error.code = 'TRIGGER_PLAN_SEQUENCE_REQUIRES_MULTIPLE_EVENTS';
      throw error;
    }
    return { kind: 'sequence', refs };
  }

  if (match === 'any' || refs.length === 1) {
    return { kind: 'anyOf', refs };
  }

  return { kind: 'allOf', refs };
}

function lifecycleFor(input = {}) {
  return {
    oneShot: input.oneShot ?? false,
    cooldownMs: input.cooldownMs ?? 0,
    completeOnGoal: input.completeOnGoal ?? false,
    ...(input.maxFirings !== undefined ? { maxFirings: input.maxFirings } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.leaseUntil ? { leaseUntil: input.leaseUntil } : {}),
  };
}

export class TriggerPlanner {
  constructor({ store }) {
    this.store = store;
  }

  async plan(input) {
    const plan = parseTriggerPlanInput(input);
    const activeSources = this.store.listEventSources({ enabledOnly: true });
    const warnings = [];
    const resolvedSources = [];
    const seenIds = new Set();

    const clauses = plan.events.map((event, index) => {
      const id = String(event.id || `event_${index + 1}`);
      if (seenIds.has(id)) {
        const error = new Error(`Duplicate plan event id: ${id}`);
        error.code = 'TRIGGER_PLAN_DUPLICATE_EVENT_ID';
        throw error;
      }
      seenIds.add(id);

      const matches = activeSources.filter((source) =>
        source.eventName === event.event &&
        (!event.serverId || source.serverId === event.serverId)
      );

      if (matches.length === 0) {
        throw sourceError(
          'TRIGGER_PLAN_SOURCE_NOT_FOUND',
          `No active source exposes ${event.serverId ? `${event.serverId}/` : ''}${event.event}`,
          activeSources.filter((source) => source.eventName === event.event),
        );
      }
      if (matches.length > 1 && !event.serverId) {
        throw sourceError(
          'TRIGGER_PLAN_SOURCE_AMBIGUOUS',
          `Event ${event.event} is exposed by multiple sources; provide serverId`,
          matches,
        );
      }

      const source = matches[0];
      validateArgumentsAgainstSource(source, event.arguments);
      for (const predicate of event.where) {
        validatePredicateAgainstSource(source, predicate, warnings);
      }
      resolvedSources.push(source);

      return {
        id,
        event: event.event,
        serverId: source.serverId,
        arguments: event.arguments,
        where: event.where,
      };
    });

    const refs = clauses.map((clause) => clause.id);
    const correlation = {};
    if (plan.correlateBy) {
      for (const field of plan.correlateBy) {
        if (!refs.includes(field.eventId)) {
          const error = new Error(
            `Correlation references unknown event id: ${field.eventId}`,
          );
          error.code = 'TRIGGER_PLAN_EVENT_REF_UNKNOWN';
          throw error;
        }
        const clause = clauses.find((candidate) => candidate.id === field.eventId);
        const source = resolvedSources[clauses.indexOf(clause)];
        validatePredicateAgainstSource(
          source,
          { path: field.path, op: 'exists', value: true },
          warnings,
        );
      }
      correlation.deterministic = {
        kind: 'same_value',
        fields: plan.correlateBy.map((field) => ({
          ref: field.eventId,
          path: field.path,
        })),
      };
    }
    if (plan.semanticCorrelation) {
      correlation.semantic = plan.semanticCorrelation;
    }

    const triggerId = plan.triggerId || `planned_${(
      await sha256Hex(canonicalJson({
        target: plan.target,
        events: plan.events,
        match: plan.match,
        continuation: plan.continuation.instruction,
      }))
    ).slice(0, 24)}`;

    const definition = parseCompositeTriggerDefinition({
      triggerId,
      version: plan.version,
      description:
        plan.description ||
        plan.continuation.instruction.slice(0, 500),
      continuation: plan.continuation,
      clauses,
      expression: expressionFor(plan.match, refs),
      withinMs: plan.withinMs,
      lifecycle: lifecycleFor(plan.lifecycle),
      ...(Object.keys(correlation).length ? { correlation } : {}),
      target: plan.target,
    });

    return {
      planVersion: '1',
      definition,
      connectionIds: [...new Set(resolvedSources.map((source) => source.connectionId))],
      resolvedSources: resolvedSources.map(sourceSummary),
      warnings,
      explanation: {
        when: {
          expression: definition.expression,
          events: clauses.map((clause) => ({
            id: clause.id,
            event: clause.event,
            serverId: clause.serverId,
            arguments: clause.arguments,
            where: clause.where,
          })),
          withinMs: definition.withinMs,
        },
        then: {
          target: definition.target,
          instruction: definition.continuation?.instruction ?? null,
          evidence: definition.continuation?.contextPolicy?.evidence ?? 'matched_events',
        },
      },
    };
  }
}

export default { TriggerPlanner };
