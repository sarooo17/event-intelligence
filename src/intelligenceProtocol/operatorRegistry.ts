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
      example: { path: 'status', op: 'eq', value: 'open' },
    },
    {
      id: PREDICATE_OPERATOR.NEQ,
      description: 'Field does not equal a scalar value.',
      fields: ['path', 'value'],
      example: { path: 'status', op: 'neq', value: 'cancelled' },
    },
    {
      id: PREDICATE_OPERATOR.CONTAINS,
      description: 'String/array field contains the supplied scalar value.',
      fields: ['path', 'value'],
      example: { path: 'subject', op: 'contains', value: 'invoice' },
    },
    {
      id: PREDICATE_OPERATOR.STARTS_WITH,
      description: 'String field starts with the supplied text.',
      fields: ['path', 'value'],
      example: { path: 'subject', op: 'startsWith', value: 'URGENT:' },
    },
    {
      id: PREDICATE_OPERATOR.ENDS_WITH,
      description: 'String field ends with the supplied text.',
      fields: ['path', 'value'],
      example: { path: 'filename', op: 'endsWith', value: '.pdf' },
    },
    {
      id: PREDICATE_OPERATOR.REGEX,
      description: 'String field matches a regular expression.',
      fields: ['path', 'value'],
      optionalFields: ['flags'],
      example: { path: 'code', op: 'regex', value: '^ERR-[0-9]+$' },
    },
    {
      id: PREDICATE_OPERATOR.IN,
      description: 'Field equals one of the supplied scalar values.',
      fields: ['path', 'value'],
      example: { path: 'status', op: 'in', value: ['open', 'pending'] },
    },
    {
      id: PREDICATE_OPERATOR.NOT_IN,
      description: 'Field does not equal any supplied scalar value.',
      fields: ['path', 'value'],
      example: { path: 'status', op: 'notIn', value: ['cancelled', 'closed'] },
    },
    {
      id: PREDICATE_OPERATOR.BETWEEN,
      description: 'Comparable field is inside the inclusive range.',
      fields: ['path', 'value'],
      example: { path: 'amount', op: 'between', value: [1000, 5000] },
    },
    {
      id: PREDICATE_OPERATOR.EXISTS,
      description: 'Field presence must match the supplied boolean.',
      fields: ['path', 'value'],
      example: { path: 'customerId', op: 'exists', value: true },
    },
    {
      id: PREDICATE_OPERATOR.IS_NULL,
      description: 'Field null/undefined state must match the supplied boolean.',
      fields: ['path', 'value'],
      example: { path: 'closedAt', op: 'isNull', value: true },
    },
    {
      id: PREDICATE_OPERATOR.TYPE,
      description: 'Field must have the requested JSON type.',
      fields: ['path', 'value'],
      values: ['string', 'number', 'boolean', 'null', 'object', 'array'],
      example: { path: 'total', op: 'type', value: 'number' },
    },
    {
      id: PREDICATE_OPERATOR.GT,
      description: 'Numeric field is greater than the supplied number.',
      fields: ['path', 'value'],
      example: { path: 'grand_total', op: 'gt', value: 10000 },
    },
    {
      id: PREDICATE_OPERATOR.GTE,
      description: 'Numeric field is greater than or equal to the supplied number.',
      fields: ['path', 'value'],
      example: { path: 'grand_total', op: 'gte', value: 10000 },
    },
    {
      id: PREDICATE_OPERATOR.LT,
      description: 'Numeric field is less than the supplied number.',
      fields: ['path', 'value'],
      example: { path: 'stock', op: 'lt', value: 10 },
    },
    {
      id: PREDICATE_OPERATOR.LTE,
      description: 'Numeric field is less than or equal to the supplied number.',
      fields: ['path', 'value'],
      example: { path: 'stock', op: 'lte', value: 10 },
    },
  ]),

  composition: Object.freeze([
    {
      id: COMPOSITION_OPERATOR.ALL,
      canonicalKind: 'allOf',
      description: 'All referenced events must satisfy the legacy trigger.',
      example: { match: 'all' },
    },
    {
      id: COMPOSITION_OPERATOR.ANY,
      canonicalKind: 'anyOf',
      description: 'Any referenced event may satisfy the legacy trigger.',
      example: { match: 'any' },
    },
    {
      id: COMPOSITION_OPERATOR.SEQUENCE,
      canonicalKind: 'sequence',
      description: 'Referenced events must occur in event-time order.',
      example: { match: 'sequence' },
    },
    {
      id: COMPOSITION_OPERATOR.COUNT,
      canonicalKind: 'count',
      description: 'One referenced event must occur at least N times.',
      example: { match: { kind: 'count', eventId: 'comment', atLeast: 3 } },
    },
  ]),

  temporal: Object.freeze([
    {
      id: TEMPORAL_OPERATOR.CALENDAR,
      description: 'Calendar/timezone constraint.',
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
      description: 'Referenced event must remain absent after an anchor for a durable period.',
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
      description: 'Referenced event must not be present.',
      fields: ['id', 'kind', 'ref'],
      example: { id: 'not-cancelled', kind: 'not', ref: 'cancelled' },
    },
    {
      id: TEMPORAL_OPERATOR.UNLESS,
      description: 'Condition remains valid unless the referenced event occurs.',
      fields: ['id', 'kind', 'ref'],
      example: { id: 'unless-blocked', kind: 'unless', ref: 'blocked' },
    },
    {
      id: TEMPORAL_OPERATOR.AFTER,
      description: 'ref must occur after afterRef.',
      fields: ['id', 'kind', 'ref', 'afterRef'],
      example: { id: 'deploy-after-merge', kind: 'after', ref: 'deploy', afterRef: 'merge' },
    },
    {
      id: TEMPORAL_OPERATOR.UNTIL,
      description: 'ref must occur no later than beforeRef.',
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
      description: 'At least N occurrences are required.',
      fields: ['id', 'kind', 'ref', 'atLeast'],
      example: { id: 'three-comments', kind: 'threshold', ref: 'comment', atLeast: 3 },
    },
    {
      id: TEMPORAL_OPERATOR.RATE,
      description: 'At least N occurrences are required within a duration.',
      fields: ['id', 'kind', 'ref', 'atLeast', 'perMs'],
      example: { id: 'order-spike', kind: 'rate', ref: 'order', atLeast: 5, perMs: 600000 },
    },
    {
      id: TEMPORAL_OPERATOR.DISTINCT,
      description: 'At least N distinct values are required.',
      fields: ['id', 'kind', 'ref', 'path', 'atLeast'],
      example: { id: 'three-customers', kind: 'distinct', ref: 'order', path: 'customer', atLeast: 3 },
    },
  ]),

  pattern: Object.freeze([
    {
      id: 'event',
      description: 'Bind one discovered event alias.',
      example: { kind: 'event', ref: 'order' },
    },
    {
      id: 'allOf',
      description: 'Nested conjunction of child patterns.',
    },
    {
      id: 'anyOf',
      description: 'Nested disjunction of child patterns.',
    },
    {
      id: 'sequence',
      description: 'Ordered child patterns with explicit contiguity.',
      contiguity: ['next', 'followedBy', 'followedByAny'],
    },
    {
      id: 'repeat',
      description: 'Quantifier with min/max, greedy/lazy preference and explicit internal contiguity.',
      fields: ['child', 'min'],
      optionalFields: ['max', 'mode', 'contiguity'],
      contiguity: ['consecutive', 'relaxed', 'combinations'],
    },
    {
      id: 'optional',
      description: 'Optional child pattern with greedy/lazy preference.',
      fields: ['child'],
      optionalFields: ['mode'],
    },
    {
      id: 'notNext',
      description: 'Reject when the immediately next relevant event matches the forbidden pattern.',
    },
    {
      id: 'notFollowedBy',
      description: 'Durable bounded negative look-ahead.',
      fields: ['id', 'child', 'forbidden', 'withinMs'],
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
      description: 'Filter a nested pattern using an aggregate.',
    },
    {
      id: 'state',
      description: 'Detect state changes, deltas, crossings or stable periods.',
    },
    {
      id: 'semantic',
      description: 'Vendor-neutral semantic predicate evaluated through SemanticEvaluator; Jev is optional.',
    },
    {
      id: 'calendar',
      description: 'Calendar/timezone filter as a v2 wrapper node.',
    },
    {
      id: 'absence',
      description: 'Durable absence condition as a v2 wrapper node.',
    },
    {
      id: 'notPresent',
      description: 'Require an alias to be absent from the active partition buffer.',
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
      description: 'Require at least N occurrences within a duration.',
    },
    {
      id: 'distinct',
      description: 'Require at least N distinct values.',
    },
  ]),

  windows: Object.freeze([
    { id: 'within', description: 'Maximum event-time span.', fields: ['sizeMs'] },
    { id: 'sliding', description: 'Sliding event-time window.', fields: ['sizeMs'] },
    { id: 'tumbling', description: 'Non-overlapping fixed event-time windows.', fields: ['sizeMs'], optionalFields: ['offsetMs'] },
    { id: 'hopping', description: 'Overlapping fixed event-time windows.', fields: ['sizeMs', 'hopMs'], optionalFields: ['offsetMs'] },
    { id: 'session', description: 'Sessionize by maximum inactivity gap.', fields: ['gapMs'] },
    { id: 'count', description: 'Bound a candidate by stream-position count.', fields: ['size'] },
  ]),

  aggregates: Object.freeze([
    { id: 'sum', description: 'Sum numeric values.' },
    { id: 'avg', description: 'Average numeric values.' },
    { id: 'min', description: 'Minimum numeric value.' },
    { id: 'max', description: 'Maximum numeric value.' },
    { id: 'count', description: 'Count occurrences.' },
    { id: 'countDistinct', description: 'Count distinct values.' },
    { id: 'first', description: 'First value in event-time order.' },
    { id: 'last', description: 'Last value in event-time order.' },
    { id: 'nth', description: 'Nth value in event-time order.' },
    { id: 'stddev', description: 'Population standard deviation.' },
    { id: 'percentile', description: 'Interpolated percentile.' },
  ]),

  state: Object.freeze([
    { id: 'changed', description: 'Value changed between the latest two occurrences.' },
    { id: 'changedFrom', description: 'Value changed from one explicit value to another.' },
    { id: 'increasedBy', description: 'Numeric increase satisfies a comparator.' },
    { id: 'decreasedBy', description: 'Numeric decrease satisfies a comparator.' },
    { id: 'delta', description: 'Numeric delta satisfies a comparator.' },
    { id: 'percentChange', description: 'Percentage change satisfies a comparator.' },
    { id: 'stableFor', description: 'Value remained stable for a duration.' },
    { id: 'crossesAbove', description: 'Value crossed upward through a threshold.' },
    { id: 'crossesBelow', description: 'Value crossed downward through a threshold.' },
  ]),

  selection: Object.freeze([
    {
      id: 'overlap',
      values: ['allow', 'disallow'],
      description: 'Whether emitted matches may share physical source events.',
    },
    {
      id: 'afterMatch',
      values: [
        'skipPastLast',
        'skipToNext',
        'keepAll',
        { kind: 'skipToFirst', ref: '<pattern-ref>' },
        { kind: 'skipToLast', ref: '<pattern-ref>' },
      ],
      description: 'How candidate matching and the partition buffer advance after a match. skipToFirst/skipToLast require an explicit pattern ref.',
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
      description: 'First-class semantic predicate. The configured SemanticEvaluator executes it; TypeSafe Jev is the bundled optional evaluator.',
      fields: ['id', 'child', 'refs', 'instruction', 'input', 'matchThreshold', 'rejectThreshold'],
      optionalFields: ['uncertain', 'execution.cache', 'execution.timeoutMs', 'execution.onUnavailable'],
    },
  ]),

  correlation: Object.freeze([
    {
      id: 'same_value',
      description: 'Legacy deterministic same-value correlation.',
      authoringField: 'correlateBy',
    },
    {
      id: 'semantic',
      description: 'Legacy semantic-correlation compatibility field.',
      authoringField: 'semanticCorrelation',
    },
    {
      id: 'partitionBy',
      description: 'Pattern AST v2 partitions stream state by one or more named dimensions.',
      authoringField: 'patternV2.partitionBy',
    },
  ]),

  timing: Object.freeze([
    {
      id: 'withinMs',
      description: 'Global bounded retention / maximum pattern horizon.',
    },
    {
      id: 'allowedLatenessMs',
      description: 'Bounded tolerance for out-of-order event delivery.',
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
