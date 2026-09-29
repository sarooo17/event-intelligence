export const TRIGGER_LANGUAGE_VERSION = '2' as const;

export const PREDICATE_OPERATOR = {
  EQ: 'eq',
  NEQ: 'neq',
  CONTAINS: 'contains',
  STARTS_WITH: 'startsWith',
  ENDS_WITH: 'endsWith',
  REGEX: 'regex',
  IN: 'in',
  NOT_IN: 'notIn',
  BETWEEN: 'between',
  EXISTS: 'exists',
  IS_NULL: 'isNull',
  TYPE: 'type',
  GT: 'gt',
  GTE: 'gte',
  LT: 'lt',
  LTE: 'lte',
} as const;

export const COMPOSITION_OPERATOR = {
  ALL: 'all',
  ANY: 'any',
  SEQUENCE: 'sequence',
  COUNT: 'count',
} as const;

export const TEMPORAL_OPERATOR = {
  CALENDAR: 'calendar',
  ABSENCE: 'absence',
  NOT: 'not',
  UNLESS: 'unless',
  AFTER: 'after',
  UNTIL: 'until',
  DEBOUNCE: 'debounce',
  THRESHOLD: 'threshold',
  RATE: 'rate',
  DISTINCT: 'distinct',
} as const;

export const TRIGGER_LANGUAGE_CATALOG = Object.freeze({
  version: TRIGGER_LANGUAGE_VERSION,
  predicates: Object.freeze([
    {
      id: PREDICATE_OPERATOR.EQ,
      description: 'Field equals a scalar value.',
      fields: ['path', 'value'],
      valueType: 'scalar',
      example: { path: 'status', op: 'eq', value: 'open' },
    },
    {
      id: PREDICATE_OPERATOR.NEQ,
      description: 'Field does not equal a scalar value.',
      fields: ['path', 'value'],
      valueType: 'scalar',
      example: { path: 'status', op: 'neq', value: 'cancelled' },
    },
    {
      id: PREDICATE_OPERATOR.CONTAINS,
      description: 'Field contains a scalar value.',
      fields: ['path', 'value'],
      valueType: 'scalar',
      example: { path: 'subject', op: 'contains', value: 'invoice' },
    },
    {
      id: PREDICATE_OPERATOR.STARTS_WITH,
      description: 'String field starts with the supplied text.',
      fields: ['path', 'value'],
      valueType: 'string',
      example: { path: 'subject', op: 'startsWith', value: 'URGENT:' },
    },
    {
      id: PREDICATE_OPERATOR.ENDS_WITH,
      description: 'String field ends with the supplied text.',
      fields: ['path', 'value'],
      valueType: 'string',
      example: { path: 'filename', op: 'endsWith', value: '.pdf' },
    },
    {
      id: PREDICATE_OPERATOR.REGEX,
      description: 'String field matches a regular expression.',
      fields: ['path', 'value'],
      optionalFields: ['flags'],
      valueType: 'string',
      example: { path: 'code', op: 'regex', value: '^ERR-[0-9]+
    {
      id: PREDICATE_OPERATOR.IN,
      description: 'Field equals one of the supplied scalar values.',
      fields: ['path', 'value'],
      valueType: 'scalar[]',
      example: { path: 'status', op: 'in', value: ['open', 'pending'] },
    },
    {
      id: PREDICATE_OPERATOR.NOT_IN,
      description: 'Field does not equal any supplied scalar value.',
      fields: ['path', 'value'],
      valueType: 'scalar[]',
      example: { path: 'status', op: 'notIn', value: ['cancelled', 'closed'] },
    },
    {
      id: PREDICATE_OPERATOR.BETWEEN,
      description: 'Comparable field is inside the inclusive [lower, upper] range.',
      fields: ['path', 'value'],
      valueType: '[scalar, scalar]',
      example: { path: 'amount', op: 'between', value: [1000, 5000] },
    },
    {
      id: PREDICATE_OPERATOR.EXISTS,
      description: 'Field presence must match the supplied boolean.',
      fields: ['path', 'value'],
      valueType: 'boolean',
      example: { path: 'customerId', op: 'exists', value: true },
    },
    {
      id: PREDICATE_OPERATOR.IS_NULL,
      description: 'Field null/undefined state must match the supplied boolean.',
      fields: ['path', 'value'],
      valueType: 'boolean',
      example: { path: 'closedAt', op: 'isNull', value: true },
    },
    {
      id: PREDICATE_OPERATOR.TYPE,
      description: 'Field must have the requested JSON type.',
      fields: ['path', 'value'],
      valueType: 'string|number|boolean|null|object|array',
      example: { path: 'total', op: 'type', value: 'number' },
    },
    {
      id: PREDICATE_OPERATOR.GT,
      description: 'Numeric field is greater than the supplied number.',
      fields: ['path', 'value'],
      valueType: 'number',
      example: { path: 'grand_total', op: 'gt', value: 10000 },
    },
    {
      id: PREDICATE_OPERATOR.GTE,
      description: 'Numeric field is greater than or equal to the supplied number.',
      fields: ['path', 'value'],
      valueType: 'number',
      example: { path: 'grand_total', op: 'gte', value: 10000 },
    },
    {
      id: PREDICATE_OPERATOR.LT,
      description: 'Numeric field is less than the supplied number.',
      fields: ['path', 'value'],
      valueType: 'number',
      example: { path: 'stock', op: 'lt', value: 10 },
    },
    {
      id: PREDICATE_OPERATOR.LTE,
      description: 'Numeric field is less than or equal to the supplied number.',
      fields: ['path', 'value'],
      valueType: 'number',
      example: { path: 'stock', op: 'lte', value: 10 },
    },
  ]),
  composition: Object.freeze([
    {
      id: COMPOSITION_OPERATOR.ALL,
      canonicalKind: 'allOf',
      description: 'All referenced events must satisfy the trigger.',
      minEvents: 1,
      example: { match: 'all' },
    },
    {
      id: COMPOSITION_OPERATOR.ANY,
      canonicalKind: 'anyOf',
      description: 'Any referenced event may satisfy the trigger.',
      minEvents: 1,
      example: { match: 'any' },
    },
    {
      id: COMPOSITION_OPERATOR.SEQUENCE,
      canonicalKind: 'sequence',
      description: 'Referenced events must occur in event-time order.',
      minEvents: 2,
      example: { match: 'sequence' },
    },
    {
      id: COMPOSITION_OPERATOR.COUNT,
      canonicalKind: 'count',
      description: 'One referenced event must occur at least N times.',
      minEvents: 1,
      example: { match: { kind: 'count', eventId: 'comment', atLeast: 3 } },
    },
  ]),
  temporal: Object.freeze([
    {
      id: TEMPORAL_OPERATOR.CALENDAR,
      description: 'Referenced event must fall inside a calendar/timezone constraint.',
      fields: ['id', 'kind', 'ref', 'timezone'],
      optionalFields: ['before', 'after', 'weekdays', 'dates', 'dateRange', 'dayOfMonth'],
      example: {
        id: 'business-hours',
        kind: 'calendar',
        ref: 'order',
        timezone: 'Europe/Rome',
        after: '09:00',
        before: '18:00',
        weekdays: [1, 2, 3, 4, 5],
      },
    },
    {
      id: TEMPORAL_OPERATOR.ABSENCE,
      description: 'Referenced event must not occur after an anchor during a durable time window.',
      fields: ['id', 'kind', 'ref', 'afterRef'],
      oneOf: [['forMs'], ['untilLocalTime', 'timezone']],
      example: {
        id: 'no-errors',
        kind: 'absence',
        ref: 'error',
        afterRef: 'deploy',
        forMs: 600000,
      },
    },
    {
      id: TEMPORAL_OPERATOR.NOT,
      description: 'Referenced event must not be present in the current match.',
      fields: ['id', 'kind', 'ref'],
      example: { id: 'not-cancelled', kind: 'not', ref: 'cancelled' },
    },
    {
      id: TEMPORAL_OPERATOR.UNLESS,
      description: 'Condition remains valid unless the referenced event is present.',
      fields: ['id', 'kind', 'ref'],
      example: { id: 'unless-blocked', kind: 'unless', ref: 'blocked' },
    },
    {
      id: TEMPORAL_OPERATOR.AFTER,
      description: 'ref must occur after afterRef in event-time.',
      fields: ['id', 'kind', 'ref', 'afterRef'],
      example: { id: 'deploy-after-merge', kind: 'after', ref: 'deploy', afterRef: 'merge' },
    },
    {
      id: TEMPORAL_OPERATOR.UNTIL,
      description: 'ref must occur no later than beforeRef in event-time.',
      fields: ['id', 'kind', 'ref', 'beforeRef'],
      example: { id: 'approve-before-expiry', kind: 'until', ref: 'approval', beforeRef: 'expiry' },
    },
    {
      id: TEMPORAL_OPERATOR.DEBOUNCE,
      description: 'Wait for a quiet period after the latest referenced event.',
      fields: ['id', 'kind', 'ref', 'forMs'],
      example: { id: 'quiet', kind: 'debounce', ref: 'change', forMs: 300000 },
    },
    {
      id: TEMPORAL_OPERATOR.THRESHOLD,
      description: 'At least N occurrences of the referenced event must be in the match.',
      fields: ['id', 'kind', 'ref', 'atLeast'],
      example: { id: 'three-comments', kind: 'threshold', ref: 'comment', atLeast: 3 },
    },
    {
      id: TEMPORAL_OPERATOR.RATE,
      description: 'At least N referenced events must occur during the configured duration.',
      fields: ['id', 'kind', 'ref', 'atLeast', 'perMs'],
      example: { id: 'order-spike', kind: 'rate', ref: 'order', atLeast: 5, perMs: 600000 },
    },
    {
      id: TEMPORAL_OPERATOR.DISTINCT,
      description: 'At least N distinct values at path must appear across referenced events.',
      fields: ['id', 'kind', 'ref', 'path', 'atLeast'],
      example: { id: 'three-customers', kind: 'distinct', ref: 'order', path: 'customer', atLeast: 3 },
    },
  ]),
  pattern: Object.freeze([
    {
      id: 'event',
      description: 'Bind one discovered event alias into the pattern.',
      example: { kind: 'event', ref: 'order' },
    },
    {
      id: 'allOf',
      description: 'Nested conjunction of child patterns.',
      example: { kind: 'allOf', children: [{ kind: 'event', ref: 'a' }, { kind: 'event', ref: 'b' }] },
    },
    {
      id: 'anyOf',
      description: 'Nested disjunction of child patterns.',
      example: { kind: 'anyOf', children: [{ kind: 'event', ref: 'a' }, { kind: 'event', ref: 'b' }] },
    },
    {
      id: 'sequence',
      description: 'Ordered child patterns with explicit contiguity.',
      contiguity: ['next', 'followedBy', 'followedByAny'],
      example: {
        kind: 'sequence',
        contiguity: 'followedBy',
        children: [{ kind: 'event', ref: 'a' }, { kind: 'event', ref: 'b' }],
      },
    },
    {
      id: 'repeat',
      description: 'Quantifier with min/max and greedy/lazy mode. Expresses *, +, exactly, ranges and atLeast.',
      example: {
        kind: 'repeat',
        child: { kind: 'event', ref: 'failure' },
        min: 2,
        max: 5,
        mode: 'greedy',
      },
    },
    {
      id: 'optional',
      description: 'Optional child pattern, greedy or lazy.',
      example: { kind: 'optional', child: { kind: 'event', ref: 'ticket' }, mode: 'greedy' },
    },
    {
      id: 'notNext',
      description: 'Reject when the immediately next relevant event matches the forbidden pattern.',
    },
    {
      id: 'notFollowedBy',
      description: 'Durable negative look-ahead over a bounded event-time interval.',
    },
    {
      id: 'window',
      description: 'Apply a streaming window to a nested pattern.',
    },
    {
      id: 'compare',
      description: 'Cross-event/value comparison with arithmetic expressions.',
    },
    {
      id: 'aggregate',
      description: 'Filter a nested pattern using an aggregate value.',
    },
    {
      id: 'state',
      description: 'Detect changes, deltas, threshold crossings and stable periods.',
    },
    {
      id: 'semantic',
      description: 'First-class semantic predicate evaluated through SemanticEvaluator; TypeSafe Jev is the bundled optional implementation.',
    },
    {
      id: 'calendar',
      description: 'Calendar/timezone constraint as a v2 pattern node.',
    },
    {
      id: 'absence',
      description: 'Durable absence condition as a v2 pattern node.',
    },
    {
      id: 'notPresent',
      description: 'Require an event alias to be absent from the active partition buffer.',
    },
    {
      id: 'after',
      description: 'Require one bound event to occur after another.',
    },
    {
      id: 'until',
      description: 'Require one bound event to occur no later than another.',
    },
    {
      id: 'debounce',
      description: 'Require a quiet period after the latest referenced event.',
    },
    {
      id: 'threshold',
      description: 'Require at least N occurrences in the active partition.',
    },
    {
      id: 'rate',
      description: 'Require at least N occurrences in a duration.',
    },
    {
      id: 'distinct',
      description: 'Require at least N distinct payload values.',
    },
  ]),
  windows: Object.freeze([
    { id: 'within', description: 'Maximum event-time span.', fields: ['sizeMs'] },
    { id: 'sliding', description: 'Sliding event-time window.', fields: ['sizeMs'] },
    { id: 'tumbling', description: 'Non-overlapping fixed event-time windows.', fields: ['sizeMs'], optionalFields: ['offsetMs'] },
    { id: 'hopping', description: 'Overlapping fixed windows.', fields: ['sizeMs', 'hopMs'], optionalFields: ['offsetMs'] },
    { id: 'session', description: 'Sessionize events by maximum inactivity gap.', fields: ['gapMs'] },
    { id: 'count', description: 'Bound a candidate by stream position count.', fields: ['size'] },
  ]),
  aggregates: Object.freeze([
    ...['sum', 'avg', 'min', 'max', 'count', 'countDistinct', 'first', 'last', 'nth', 'stddev', 'percentile']
      .map((id) => ({ id, description: `CEP aggregate ${id}.` })),
  ]),
  state: Object.freeze([
    ...['changed', 'changedFrom', 'increasedBy', 'decreasedBy', 'delta', 'percentChange', 'stableFor', 'crossesAbove', 'crossesBelow']
      .map((id) => ({ id, description: `State transition operator ${id}.` })),
  ]),
  selection: Object.freeze([
    {
      id: 'overlap',
      values: ['allow', 'disallow'],
      description: 'Whether emitted matches may share physical source events.',
    },
    {
      id: 'afterMatch',
      values: ['skipPastLast', 'skipToNext', 'skipToFirst', 'skipToLast', 'keepAll'],
      description: 'How the partition buffer advances after a match.',
    },
    {
      id: 'greedyLazy',
      values: ['greedy', 'lazy'],
      description: 'Quantifier preference when multiple cardinalities are valid.',
    },
  ]),
  semantic: Object.freeze([
    {
      id: 'semantic',
      description: 'Vendor-neutral semantic predicate. Uses the configured SemanticEvaluator; Jev is optional/default when TYPESAFE_API_KEY is present.',
      fields: ['id', 'child', 'refs', 'instruction', 'input', 'matchThreshold', 'rejectThreshold'],
      optionalFields: ['uncertain', 'execution'],
    },
  ]),
  correlation: Object.freeze([
    {
      id: 'same_value',
      description: 'Deterministically correlate events by equal values at selected payload paths.',
      authoringField: 'correlateBy',
    },
    {
      id: 'semantic',
      description: 'Use the configured semantic evaluator when deterministic keys are insufficient.',
      authoringField: 'semanticCorrelation',
    },
  ]),
  timing: Object.freeze([
    {
      id: 'withinMs',
      description: 'Maximum event-time span of one composite match.',
    },
    {
      id: 'allowedLatenessMs',
      description: 'Bounded tolerance for out-of-order event delivery before the event-time watermark advances.',
      authoringPath: 'eventTime.allowedLatenessMs',
    },
  ]),
  lifecycle: Object.freeze([
    { id: 'oneShot', description: 'Complete after the first delivered effect.' },
    { id: 'maxFirings', description: 'Complete after N delivered effects.' },
    { id: 'cooldownMs', description: 'Minimum processing-time delay between effects.' },
    { id: 'expiresAt', description: 'Absolute trigger expiry timestamp.' },
    { id: 'leaseUntil', description: 'Absolute trigger lease boundary.' },
    { id: 'completeOnGoal', description: 'Complete lifecycle after goal delivery.' },
  ]),
});

export type TriggerLanguageCategory =
  | 'predicates'
  | 'composition'
  | 'temporal'
  | 'pattern'
  | 'windows'
  | 'aggregates'
  | 'state'
  | 'selection'
  | 'semantic'
  | 'correlation'
  | 'timing'
  | 'lifecycle';

export function describeTriggerLanguage(input: {
  category?: TriggerLanguageCategory;
  operator?: string;
} = {}) {
  const { category, operator } = input;
  const categories = category
    ? [category]
    : (Object.keys(TRIGGER_LANGUAGE_CATALOG)
        .filter((key) => key !== 'version') as TriggerLanguageCategory[]);

  const result: Record<string, unknown> = {
    version: TRIGGER_LANGUAGE_VERSION,
    authoringSurface: 'TriggerPlanInput',
    planner: 'trigger_plan',
    preferredAuthoring: 'TriggerPlanInput.patternV2',
    canonicalRepresentation: 'CompositeTriggerDefinition + PatternAstV2',
  };

  for (const key of categories) {
    const entries = TRIGGER_LANGUAGE_CATALOG[key];
    const filtered = operator
      ? entries.filter((entry) => entry.id === operator)
      : entries;
    result[key] = filtered;
  }

  return result;
}
 },
    },
    {
      id: PREDICATE_OPERATOR.IN,
      description: 'Field equals one of the supplied scalar values.',
      fields: ['path', 'value'],
      valueType: 'scalar[]',
      example: { path: 'status', op: 'in', value: ['open', 'pending'] },
    },
    {
      id: PREDICATE_OPERATOR.EXISTS,
      description: 'Field presence must match the supplied boolean.',
      fields: ['path', 'value'],
      valueType: 'boolean',
      example: { path: 'customerId', op: 'exists', value: true },
    },
    {
      id: PREDICATE_OPERATOR.GT,
      description: 'Numeric field is greater than the supplied number.',
      fields: ['path', 'value'],
      valueType: 'number',
      example: { path: 'grand_total', op: 'gt', value: 10000 },
    },
    {
      id: PREDICATE_OPERATOR.GTE,
      description: 'Numeric field is greater than or equal to the supplied number.',
      fields: ['path', 'value'],
      valueType: 'number',
      example: { path: 'grand_total', op: 'gte', value: 10000 },
    },
    {
      id: PREDICATE_OPERATOR.LT,
      description: 'Numeric field is less than the supplied number.',
      fields: ['path', 'value'],
      valueType: 'number',
      example: { path: 'stock', op: 'lt', value: 10 },
    },
    {
      id: PREDICATE_OPERATOR.LTE,
      description: 'Numeric field is less than or equal to the supplied number.',
      fields: ['path', 'value'],
      valueType: 'number',
      example: { path: 'stock', op: 'lte', value: 10 },
    },
  ]),
  composition: Object.freeze([
    {
      id: COMPOSITION_OPERATOR.ALL,
      canonicalKind: 'allOf',
      description: 'All referenced events must satisfy the trigger.',
      minEvents: 1,
      example: { match: 'all' },
    },
    {
      id: COMPOSITION_OPERATOR.ANY,
      canonicalKind: 'anyOf',
      description: 'Any referenced event may satisfy the trigger.',
      minEvents: 1,
      example: { match: 'any' },
    },
    {
      id: COMPOSITION_OPERATOR.SEQUENCE,
      canonicalKind: 'sequence',
      description: 'Referenced events must occur in event-time order.',
      minEvents: 2,
      example: { match: 'sequence' },
    },
    {
      id: COMPOSITION_OPERATOR.COUNT,
      canonicalKind: 'count',
      description: 'One referenced event must occur at least N times.',
      minEvents: 1,
      example: { match: { kind: 'count', eventId: 'comment', atLeast: 3 } },
    },
  ]),
  temporal: Object.freeze([
    {
      id: TEMPORAL_OPERATOR.CALENDAR,
      description: 'Referenced event must fall inside a calendar/timezone constraint.',
      fields: ['id', 'kind', 'ref', 'timezone'],
      optionalFields: ['before', 'after', 'weekdays', 'dates', 'dateRange', 'dayOfMonth'],
      example: {
        id: 'business-hours',
        kind: 'calendar',
        ref: 'order',
        timezone: 'Europe/Rome',
        after: '09:00',
        before: '18:00',
        weekdays: [1, 2, 3, 4, 5],
      },
    },
    {
      id: TEMPORAL_OPERATOR.ABSENCE,
      description: 'Referenced event must not occur after an anchor during a durable time window.',
      fields: ['id', 'kind', 'ref', 'afterRef'],
      oneOf: [['forMs'], ['untilLocalTime', 'timezone']],
      example: {
        id: 'no-errors',
        kind: 'absence',
        ref: 'error',
        afterRef: 'deploy',
        forMs: 600000,
      },
    },
    {
      id: TEMPORAL_OPERATOR.NOT,
      description: 'Referenced event must not be present in the current match.',
      fields: ['id', 'kind', 'ref'],
      example: { id: 'not-cancelled', kind: 'not', ref: 'cancelled' },
    },
    {
      id: TEMPORAL_OPERATOR.UNLESS,
      description: 'Condition remains valid unless the referenced event is present.',
      fields: ['id', 'kind', 'ref'],
      example: { id: 'unless-blocked', kind: 'unless', ref: 'blocked' },
    },
    {
      id: TEMPORAL_OPERATOR.AFTER,
      description: 'ref must occur after afterRef in event-time.',
      fields: ['id', 'kind', 'ref', 'afterRef'],
      example: { id: 'deploy-after-merge', kind: 'after', ref: 'deploy', afterRef: 'merge' },
    },
    {
      id: TEMPORAL_OPERATOR.UNTIL,
      description: 'ref must occur no later than beforeRef in event-time.',
      fields: ['id', 'kind', 'ref', 'beforeRef'],
      example: { id: 'approve-before-expiry', kind: 'until', ref: 'approval', beforeRef: 'expiry' },
    },
    {
      id: TEMPORAL_OPERATOR.DEBOUNCE,
      description: 'Wait for a quiet period after the latest referenced event.',
      fields: ['id', 'kind', 'ref', 'forMs'],
      example: { id: 'quiet', kind: 'debounce', ref: 'change', forMs: 300000 },
    },
    {
      id: TEMPORAL_OPERATOR.THRESHOLD,
      description: 'At least N occurrences of the referenced event must be in the match.',
      fields: ['id', 'kind', 'ref', 'atLeast'],
      example: { id: 'three-comments', kind: 'threshold', ref: 'comment', atLeast: 3 },
    },
    {
      id: TEMPORAL_OPERATOR.RATE,
      description: 'At least N referenced events must occur during the configured duration.',
      fields: ['id', 'kind', 'ref', 'atLeast', 'perMs'],
      example: { id: 'order-spike', kind: 'rate', ref: 'order', atLeast: 5, perMs: 600000 },
    },
    {
      id: TEMPORAL_OPERATOR.DISTINCT,
      description: 'At least N distinct values at path must appear across referenced events.',
      fields: ['id', 'kind', 'ref', 'path', 'atLeast'],
      example: { id: 'three-customers', kind: 'distinct', ref: 'order', path: 'customer', atLeast: 3 },
    },
  ]),
  correlation: Object.freeze([
    {
      id: 'same_value',
      description: 'Deterministically correlate events by equal values at selected payload paths.',
      authoringField: 'correlateBy',
    },
    {
      id: 'semantic',
      description: 'Use the configured semantic evaluator when deterministic keys are insufficient.',
      authoringField: 'semanticCorrelation',
    },
  ]),
  timing: Object.freeze([
    {
      id: 'withinMs',
      description: 'Maximum event-time span of one composite match.',
    },
    {
      id: 'allowedLatenessMs',
      description: 'Bounded tolerance for out-of-order event delivery before the event-time watermark advances.',
      authoringPath: 'eventTime.allowedLatenessMs',
    },
  ]),
  lifecycle: Object.freeze([
    { id: 'oneShot', description: 'Complete after the first delivered effect.' },
    { id: 'maxFirings', description: 'Complete after N delivered effects.' },
    { id: 'cooldownMs', description: 'Minimum processing-time delay between effects.' },
    { id: 'expiresAt', description: 'Absolute trigger expiry timestamp.' },
    { id: 'leaseUntil', description: 'Absolute trigger lease boundary.' },
    { id: 'completeOnGoal', description: 'Complete lifecycle after goal delivery.' },
  ]),
});

export type TriggerLanguageCategory =
  | 'predicates'
  | 'composition'
  | 'temporal'
  | 'correlation'
  | 'timing'
  | 'lifecycle';

export function describeTriggerLanguage(input: {
  category?: TriggerLanguageCategory;
  operator?: string;
} = {}) {
  const { category, operator } = input;
  const categories = category
    ? [category]
    : (Object.keys(TRIGGER_LANGUAGE_CATALOG)
        .filter((key) => key !== 'version') as TriggerLanguageCategory[]);

  const result: Record<string, unknown> = {
    version: TRIGGER_LANGUAGE_VERSION,
    authoringSurface: 'TriggerPlanInput',
    planner: 'trigger_plan',
    canonicalRepresentation: 'CompositeTriggerDefinition',
  };

  for (const key of categories) {
    const entries = TRIGGER_LANGUAGE_CATALOG[key];
    const filtered = operator
      ? entries.filter((entry) => entry.id === operator)
      : entries;
    result[key] = filtered;
  }

  return result;
}
