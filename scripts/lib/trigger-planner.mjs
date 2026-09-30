import {
  canonicalJson,
  collectPatternRefs,
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

  if (
    ['startsWith', 'endsWith', 'regex'].includes(predicate.op) &&
    node?.type &&
    node.type !== 'string'
  ) {
    throw sourceError(
      'TRIGGER_PLAN_STRING_FIELD_REQUIRED',
      `Predicate ${predicate.op} requires a string field, but ${predicate.path} is ${node.type}`,
      [source],
    );
  }
}

function clauseSourceForRef(ref, clauses, resolvedSources) {
  const index = clauses.findIndex((clause) => clause.id === ref);
  if (index < 0) {
    const error = new Error(`Temporal condition references unknown event id: ${ref}`);
    error.code = 'TRIGGER_PLAN_EVENT_REF_UNKNOWN';
    throw error;
  }
  return resolvedSources[index];
}

function validateTemporalConditions(conditions, clauses, resolvedSources, warnings) {
  const refs = new Set(clauses.map((clause) => clause.id));

  for (const condition of conditions) {
    const referenced = [];
    if ('ref' in condition) referenced.push(condition.ref);
    if ('afterRef' in condition) referenced.push(condition.afterRef);
    if ('beforeRef' in condition) referenced.push(condition.beforeRef);

    for (const ref of referenced) {
      if (!refs.has(ref)) {
        const error = new Error(
          `Temporal condition ${condition.id} references unknown event id: ${ref}`,
        );
        error.code = 'TRIGGER_PLAN_EVENT_REF_UNKNOWN';
        throw error;
      }
    }

    if (condition.kind === 'distinct') {
      const source = clauseSourceForRef(
        condition.ref,
        clauses,
        resolvedSources,
      );
      validatePredicateAgainstSource(
        source,
        { path: condition.path, op: 'exists', value: true },
        warnings,
      );
    }
  }
}

function walkPatternValue(value, visitor) {
  if (!value || typeof value !== 'object') return;
  if (value.kind === 'field') {
    visitor(value.ref, value.path, 'pattern value');
    return;
  }
  if (value.kind === 'arithmetic') {
    for (const arg of value.args ?? []) walkPatternValue(arg, visitor);
  }
}

function walkPatternNode(node, visitor) {
  if (!node || typeof node !== 'object') return;

  if (node.kind === 'compare') {
    walkPatternValue(node.left, visitor);
    if (node.right) walkPatternValue(node.right, visitor);
  }
  if (
    (node.kind === 'aggregate' ||
      node.kind === 'state' ||
      node.kind === 'distinct') &&
    node.path
  ) {
    visitor(node.ref, node.path, `pattern ${node.kind}`);
  }
  if (node.kind === 'semantic') {
    for (const input of node.input ?? []) {
      const [ref, ...parts] = String(input).split('.');
      if (ref && parts.length) {
        visitor(ref, parts.join('.'), 'pattern semantic input');
      }
    }
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) walkPatternNode(child, visitor);
  }
  if (node.child) walkPatternNode(node.child, visitor);
  if (node.forbidden) walkPatternNode(node.forbidden, visitor);
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
    const activeSources = await this.store.listEventSources({ enabledOnly: true });
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

    if (plan.patternV2) {
      const patternRefs = collectPatternRefs(plan.patternV2.root);
      for (const ref of patternRefs) {
        if (!refs.includes(ref)) {
          const error = new Error(
            `Pattern AST v2 references unknown event id: ${ref}`,
          );
          error.code = 'TRIGGER_PLAN_EVENT_REF_UNKNOWN';
          throw error;
        }
      }

      const sourceForRef = (ref) => {
        const index = clauses.findIndex((candidate) => candidate.id === ref);
        if (index < 0) {
          const error = new Error(
            `Pattern AST v2 references unknown event id: ${ref}`,
          );
          error.code = 'TRIGGER_PLAN_EVENT_REF_UNKNOWN';
          throw error;
        }
        return resolvedSources[index];
      };

      walkPatternNode(plan.patternV2.root, (ref, fieldPath, purpose) => {
        validatePredicateAgainstSource(
          sourceForRef(ref),
          { path: fieldPath, op: 'exists', value: true },
          warnings,
        );
      });

      for (const dimension of plan.patternV2.partitionBy) {
        for (const field of dimension.fields) {
          const clauseIndex = clauses.findIndex(
            (candidate) => candidate.id === field.ref,
          );
          if (clauseIndex < 0) {
            const error = new Error(
              `Pattern partition references unknown event id: ${field.ref}`,
            );
            error.code = 'TRIGGER_PLAN_EVENT_REF_UNKNOWN';
            throw error;
          }
          validatePredicateAgainstSource(
            resolvedSources[clauseIndex],
            { path: field.path, op: 'exists', value: true },
            warnings,
          );
        }
      }
    } else {
      validateTemporalConditions(
        plan.temporal,
        clauses,
        resolvedSources,
        warnings,
      );
    }

    const correlation = {};
    if (!plan.patternV2 && plan.correlateBy) {
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
    if (!plan.patternV2 && plan.semanticCorrelation) {
      correlation.semantic = plan.semanticCorrelation;
    }

    const triggerId = plan.triggerId || `planned_${(
      await sha256Hex(canonicalJson({
        target: plan.target ?? null,
        events: plan.events,
        match: plan.match,
        temporal: plan.temporal,
        patternV2: plan.patternV2 ?? null,
        eventTime: plan.eventTime ?? null,
        conditionOnly: plan.conditionOnly,
        continuation: plan.continuation?.instruction ?? null,
      }))
    ).slice(0, 24)}`;

    const definition = parseCompositeTriggerDefinition({
      triggerId,
      version: plan.version,
      ...(plan.description || plan.continuation?.instruction
        ? {
            description:
              plan.description ||
              plan.continuation.instruction.slice(0, 500),
          }
        : {}),
      conditionOnly: plan.conditionOnly,
      ...(plan.continuation ? { continuation: plan.continuation } : {}),
      clauses,
      expression: plan.patternV2
        ? { kind: 'anyOf', refs }
        : expressionFor(plan.match, refs),
      temporal: plan.patternV2 ? [] : plan.temporal,
      ...(plan.patternV2 ? { patternV2: plan.patternV2 } : {}),
      withinMs: plan.withinMs,
      ...(plan.eventTime ? { eventTime: plan.eventTime } : {}),
      lifecycle: lifecycleFor(plan.lifecycle),
      ...(Object.keys(correlation).length ? { correlation } : {}),
      ...(plan.target ? { target: plan.target } : {}),
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
          temporal: definition.temporal,
          patternV2: definition.patternV2 ?? null,
          withinMs: definition.withinMs,
          eventTime: definition.eventTime ?? { allowedLatenessMs: 0 },
        },
        then: {
          conditionOnly: definition.conditionOnly,
          target: definition.target ?? null,
          instruction: definition.continuation?.instruction ?? null,
          evidence: definition.continuation?.contextPolicy?.evidence ?? null,
        },
      },
    };
  }
}

export default { TriggerPlanner };
