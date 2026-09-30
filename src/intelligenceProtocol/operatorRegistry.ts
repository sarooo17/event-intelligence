export const TRIGGER_LANGUAGE_VERSION = '1' as const;

export const PREDICATE_OPERATOR = {
  EQ: 'eq',
  NEQ: 'neq',
  CONTAINS: 'contains',
  IN: 'in',
  EXISTS: 'exists',
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
