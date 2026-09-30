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

function defaultPattern(refs) {
  const root = refs.length === 1
    ? { kind: 'event', ref: refs[0] }
    : {
        kind: 'allOf',
        children: refs.map((ref) => ({ kind: 'event', ref })),
      };

  return {
    version: '2',
    root,
    partitionBy: [],
    selection: {
      overlap: 'disallow',
      afterMatch: 'skipPastLast',
      maxMatchesPerEvent: 10,
    },
    execution: {
      maxCandidates: 512,
      maxSemanticEvaluations: 16,
      maxBufferedEvents: 10000,
    },
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

    const pattern = plan.pattern ?? defaultPattern(refs);
    {
      const patternRefs = collectPatternRefs(pattern.root);
      for (const ref of patternRefs) {
        if (!refs.includes(ref)) {
          const error = new Error(
            `Pattern AST references unknown event id: ${ref}`,
          );
          error.code = 'TRIGGER_PLAN_EVENT_REF_UNKNOWN';
          throw error;
        }
      }

      const sourceForRef = (ref) => {
        const index = clauses.findIndex((candidate) => candidate.id === ref);
        if (index < 0) {
          const error = new Error(
            `Pattern AST references unknown event id: ${ref}`,
          );
          error.code = 'TRIGGER_PLAN_EVENT_REF_UNKNOWN';
          throw error;
        }
        return resolvedSources[index];
      };

      walkPatternNode(pattern.root, (ref, fieldPath, purpose) => {
        validatePredicateAgainstSource(
          sourceForRef(ref),
          { path: fieldPath, op: 'exists', value: true },
          warnings,
        );
      });

      for (const dimension of pattern.partitionBy) {
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
    }


    const triggerId = plan.triggerId || `planned_${(
      await sha256Hex(canonicalJson({
        target: plan.target ?? null,
        events: plan.events,
        pattern,
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
      pattern,
      withinMs: plan.withinMs,
      ...(plan.eventTime ? { eventTime: plan.eventTime } : {}),
      lifecycle: lifecycleFor(plan.lifecycle),
      ...(plan.target ? { target: plan.target } : {}),
    });

    return {
      planVersion: '2',
      definition,
      connectionIds: [...new Set(resolvedSources.map((source) => source.connectionId))],
      resolvedSources: resolvedSources.map(sourceSummary),
      warnings,
      explanation: {
        when: {
          events: clauses.map((clause) => ({
            id: clause.id,
            event: clause.event,
            serverId: clause.serverId,
            arguments: clause.arguments,
            where: clause.where,
          })),
          pattern: definition.pattern,
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
