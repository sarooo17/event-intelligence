import type {
  CompositeTriggerDefinition,
  TemporalCondition,
} from '../intelligenceProtocol/triggerSchemas.js';
import {
  PatternAstV2DefinitionSchema,
  type PatternNodeV2,
  type PatternAstV2Definition,
} from '../intelligenceProtocol/patternV2Schemas.js';

function eventNode(ref: string): PatternNodeV2 {
  return { kind: 'event', ref };
}

function expressionNode(
  definition: CompositeTriggerDefinition,
): PatternNodeV2 {
  const expression = definition.expression;

  if (expression.kind === 'allOf') {
    return {
      kind: 'allOf',
      children: expression.refs.map(eventNode),
    };
  }

  if (expression.kind === 'anyOf') {
    return {
      kind: 'anyOf',
      children: expression.refs.map(eventNode),
    };
  }

  if (expression.kind === 'sequence') {
    return {
      kind: 'sequence',
      children: expression.refs.map(eventNode),
      contiguity: 'followedBy',
    };
  }

  return {
    kind: 'repeat',
    child: eventNode(expression.ref),
    min: expression.atLeast,
    mode: 'greedy',
  };
}

function wrapTemporal(
  root: PatternNodeV2,
  condition: TemporalCondition,
): PatternNodeV2 {
  if (condition.kind === 'calendar') {
    return {
      kind: 'calendar',
      child: root,
      ref: condition.ref,
      timezone: condition.timezone,
      ...(condition.before ? { before: condition.before } : {}),
      ...(condition.after ? { after: condition.after } : {}),
      ...(condition.weekdays ? { weekdays: condition.weekdays } : {}),
      ...(condition.dates ? { dates: condition.dates } : {}),
      ...(condition.dateRange ? { dateRange: condition.dateRange } : {}),
      ...(condition.dayOfMonth ? { dayOfMonth: condition.dayOfMonth } : {}),
    };
  }

  if (condition.kind === 'absence') {
    return {
      kind: 'absence',
      id: condition.id,
      child: root,
      ref: condition.ref,
      afterRef: condition.afterRef,
      ...(condition.forMs ? { forMs: condition.forMs } : {}),
      ...(condition.untilLocalTime
        ? { untilLocalTime: condition.untilLocalTime }
        : {}),
      ...(condition.timezone ? { timezone: condition.timezone } : {}),
    };
  }

  if (condition.kind === 'not' || condition.kind === 'unless') {
    return {
      kind: 'notPresent',
      child: root,
      ref: condition.ref,
    };
  }

  if (condition.kind === 'after') {
    return {
      kind: 'after',
      child: root,
      ref: condition.ref,
      afterRef: condition.afterRef,
    };
  }

  if (condition.kind === 'until') {
    return {
      kind: 'until',
      child: root,
      ref: condition.ref,
      beforeRef: condition.beforeRef,
    };
  }

  if (condition.kind === 'debounce') {
    return {
      kind: 'debounce',
      id: condition.id,
      child: root,
      ref: condition.ref,
      forMs: condition.forMs,
    };
  }

  if (condition.kind === 'threshold') {
    return {
      kind: 'threshold',
      child: root,
      ref: condition.ref,
      atLeast: condition.atLeast,
    };
  }

  if (condition.kind === 'rate') {
    return {
      kind: 'rate',
      child: root,
      ref: condition.ref,
      atLeast: condition.atLeast,
      perMs: condition.perMs,
    };
  }

  return {
    kind: 'distinct',
    child: root,
    ref: condition.ref,
    path: condition.path,
    atLeast: condition.atLeast,
  };
}

export function compileLegacyTriggerToPatternV2(
  definition: CompositeTriggerDefinition,
): PatternAstV2Definition {
  let root = expressionNode(definition);

  const deterministic = definition.correlation?.deterministic;
  if (deterministic?.fields?.length) {
    const [anchorField, ...otherFields] = deterministic.fields;
    for (const field of otherFields) {
      root = {
        kind: 'compare',
        child: root,
        left: {
          kind: 'field',
          ref: anchorField.ref,
          path: anchorField.path,
          select: 'last',
        },
        op: 'eq',
        right: {
          kind: 'field',
          ref: field.ref,
          path: field.path,
          select: 'last',
        },
      };
    }
  }

  for (const condition of definition.temporal ?? []) {
    root = wrapTemporal(root, condition);
  }

  if (definition.correlation?.semantic) {
    const semantic = definition.correlation.semantic;
    root = {
      kind: 'semantic',
      id: 'legacy-semantic-correlation',
      child: root,
      refs: [...new Set(
        semantic.input
          .map((path) => path.split('.')[0])
          .filter(Boolean),
      )],
      instruction: semantic.instruction,
      input: semantic.input,
      matchThreshold: semantic.matchThreshold,
      rejectThreshold: semantic.rejectThreshold,
      uncertain: semantic.uncertain,
      execution: {
        cache: true,
        timeoutMs: 5000,
      },
    };
  }

  return PatternAstV2DefinitionSchema.parse({
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
    },
  });
}
