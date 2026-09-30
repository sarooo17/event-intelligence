import { z } from 'zod';

const Id = z.string().min(1).max(200);
const Scalar = z.union([z.string(), z.number(), z.boolean()]);
const ClockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PATTERN_AST_VERSION = '2' as const;

export const PatternValueSelectorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('literal'),
    value: z.union([Scalar, z.null()]),
  }).strict(),
  z.object({
    kind: z.literal('field'),
    ref: Id,
    path: z.string().min(1),
    select: z.enum(['first', 'last', 'nth']).default('last'),
    nth: z.number().int().min(0).optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.select === 'nth' && value.nth === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'field selector nth requires nth',
      });
    }
  }),
  z.object({
    kind: z.literal('occurredAt'),
    ref: Id,
    select: z.enum(['first', 'last', 'nth']).default('last'),
    nth: z.number().int().min(0).optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.select === 'nth' && value.nth === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'occurredAt selector nth requires nth',
      });
    }
  }),
]);

export type PatternValueSelector = z.infer<typeof PatternValueSelectorSchema>;

export const PatternArithmeticValueSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    PatternValueSelectorSchema,
    z.object({
      kind: z.literal('arithmetic'),
      op: z.enum(['add', 'subtract', 'multiply', 'divide', 'abs']),
      args: z.array(PatternArithmeticValueSchema).min(1).max(8),
    }).strict().superRefine((value, ctx) => {
      if (value.op === 'abs' && value.args.length !== 1) {
        ctx.addIssue({
          code: 'custom',
          message: 'abs requires exactly one argument',
        });
      }
      if (
        value.op !== 'abs' &&
        value.args.length < 2
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `${value.op} requires at least two arguments`,
        });
      }
    }),
  ]),
);

export type PatternArithmeticValue = z.infer<typeof PatternArithmeticValueSchema>;

export const PatternCompareOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'startsWith',
  'endsWith',
  'regex',
  'in',
  'notIn',
  'between',
  'isNull',
  'type',
]);

export const AggregateFunctionSchema = z.enum([
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'countDistinct',
  'first',
  'last',
  'nth',
  'stddev',
  'percentile',
]);

export const PatternWindowSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('within'),
    sizeMs: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal('sliding'),
    sizeMs: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal('tumbling'),
    sizeMs: z.number().int().positive(),
    offsetMs: z.number().int().nonnegative().default(0),
  }).strict(),
  z.object({
    type: z.literal('hopping'),
    sizeMs: z.number().int().positive(),
    hopMs: z.number().int().positive(),
    offsetMs: z.number().int().nonnegative().default(0),
  }).strict(),
  z.object({
    type: z.literal('session'),
    gapMs: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal('count'),
    size: z.number().int().min(1),
  }).strict(),
]);

export type PatternWindow = z.infer<typeof PatternWindowSchema>;

export const PatternNodeV2Schema: z.ZodType<any> = z.lazy(() => {
  const node = z.union([
    z.object({
      kind: z.literal('event'),
      ref: Id,
    }).strict(),

    z.object({
      kind: z.literal('allOf'),
      children: z.array(PatternNodeV2Schema).min(2),
    }).strict(),

    z.object({
      kind: z.literal('anyOf'),
      children: z.array(PatternNodeV2Schema).min(1),
    }).strict(),

    z.object({
      kind: z.literal('sequence'),
      children: z.array(PatternNodeV2Schema).min(2),
      contiguity: z.enum([
        'next',
        'followedBy',
        'followedByAny',
      ]).default('followedBy'),
    }).strict(),

    z.object({
      kind: z.literal('repeat'),
      child: PatternNodeV2Schema,
      min: z.number().int().min(0),
      max: z.number().int().min(1).optional(),
      mode: z.enum(['greedy', 'lazy']).default('greedy'),
      contiguity: z.enum([
        'consecutive',
        'relaxed',
        'combinations',
      ]).default('relaxed'),
    }).strict().superRefine((value, ctx) => {
      if (value.max !== undefined && value.max < value.min) {
        ctx.addIssue({
          code: 'custom',
          message: 'repeat max cannot be below min',
        });
      }
    }),

    z.object({
      kind: z.literal('optional'),
      child: PatternNodeV2Schema,
      mode: z.enum(['greedy', 'lazy']).default('greedy'),
    }).strict(),

    z.object({
      kind: z.literal('notNext'),
      child: PatternNodeV2Schema,
      forbidden: PatternNodeV2Schema,
    }).strict(),

    z.object({
      kind: z.literal('notFollowedBy'),
      id: Id,
      child: PatternNodeV2Schema,
      forbidden: PatternNodeV2Schema,
      withinMs: z.number().int().positive(),
    }).strict(),

    z.object({
      kind: z.literal('window'),
      window: PatternWindowSchema,
      child: PatternNodeV2Schema,
    }).strict(),

    z.object({
      kind: z.literal('calendar'),
      child: PatternNodeV2Schema,
      ref: Id,
      timezone: z.string().min(1),
      before: ClockTime.optional(),
      after: ClockTime.optional(),
      weekdays: z.array(z.number().int().min(1).max(7)).min(1).optional(),
      dates: z.array(CalendarDate).min(1).optional(),
      dateRange: z.object({
        start: CalendarDate,
        end: CalendarDate,
      }).optional(),
      dayOfMonth: z.array(z.number().int().min(1).max(31)).min(1).optional(),
    }).strict(),

    z.object({
      kind: z.literal('absence'),
      id: Id,
      child: PatternNodeV2Schema,
      ref: Id,
      afterRef: Id,
      forMs: z.number().int().positive().optional(),
      untilLocalTime: ClockTime.optional(),
      timezone: z.string().min(1).optional(),
    }).strict().superRefine((value, ctx) => {
      if (!value.forMs && !value.untilLocalTime) {
        ctx.addIssue({
          code: 'custom',
          message: 'absence requires forMs or untilLocalTime',
        });
      }
      if (value.untilLocalTime && !value.timezone) {
        ctx.addIssue({
          code: 'custom',
          message: 'absence untilLocalTime requires timezone',
        });
      }
    }),

    z.object({
      kind: z.literal('notPresent'),
      child: PatternNodeV2Schema,
      ref: Id,
    }).strict(),

    z.object({
      kind: z.literal('after'),
      child: PatternNodeV2Schema,
      ref: Id,
      afterRef: Id,
    }).strict(),

    z.object({
      kind: z.literal('until'),
      child: PatternNodeV2Schema,
      ref: Id,
      beforeRef: Id,
    }).strict(),

    z.object({
      kind: z.literal('debounce'),
      id: Id,
      child: PatternNodeV2Schema,
      ref: Id,
      forMs: z.number().int().positive(),
    }).strict(),

    z.object({
      kind: z.literal('threshold'),
      child: PatternNodeV2Schema,
      ref: Id,
      atLeast: z.number().int().min(1),
    }).strict(),

    z.object({
      kind: z.literal('rate'),
      child: PatternNodeV2Schema,
      ref: Id,
      atLeast: z.number().int().min(1),
      perMs: z.number().int().positive(),
    }).strict(),

    z.object({
      kind: z.literal('distinct'),
      child: PatternNodeV2Schema,
      ref: Id,
      path: z.string().min(1),
      atLeast: z.number().int().min(1),
    }).strict(),

    z.object({
      kind: z.literal('compare'),
      child: PatternNodeV2Schema,
      left: PatternArithmeticValueSchema,
      op: PatternCompareOperatorSchema,
      right: PatternArithmeticValueSchema.optional(),
      values: z.array(z.union([Scalar, z.null()])).optional(),
      lower: z.union([Scalar, z.null()]).optional(),
      upper: z.union([Scalar, z.null()]).optional(),
      expectedType: z.enum([
        'string',
        'number',
        'boolean',
        'null',
        'object',
        'array',
      ]).optional(),
      flags: z.string().max(10).optional(),
    }).strict().superRefine((value, ctx) => {
      if (
        ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'endsWith', 'regex']
          .includes(value.op) &&
        !value.right
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `compare ${value.op} requires right`,
        });
      }
      if (
        (value.op === 'in' || value.op === 'notIn') &&
        (!value.values || value.values.length === 0)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `compare ${value.op} requires values`,
        });
      }
      if (
        value.op === 'between' &&
        (value.lower === undefined || value.upper === undefined)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'compare between requires lower and upper',
        });
      }
      if (value.op === 'type' && !value.expectedType) {
        ctx.addIssue({
          code: 'custom',
          message: 'compare type requires expectedType',
        });
      }
    }),

    z.object({
      kind: z.literal('aggregate'),
      child: PatternNodeV2Schema,
      function: AggregateFunctionSchema,
      ref: Id,
      path: z.string().min(1).optional(),
      nth: z.number().int().min(0).optional(),
      percentile: z.number().min(0).max(1).optional(),
      op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
      value: z.number(),
    }).strict().superRefine((value, ctx) => {
      if (
        ['sum', 'avg', 'min', 'max', 'countDistinct', 'first', 'last', 'nth', 'stddev', 'percentile']
          .includes(value.function) &&
        value.function !== 'count' &&
        !value.path
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `${value.function} aggregate requires path`,
        });
      }
      if (value.function === 'nth' && value.nth === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'nth aggregate requires nth',
        });
      }
      if (
        value.function === 'percentile' &&
        value.percentile === undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'percentile aggregate requires percentile',
        });
      }
    }),

    z.object({
      kind: z.literal('state'),
      child: PatternNodeV2Schema,
      ref: Id,
      path: z.string().min(1),
      op: z.enum([
        'changed',
        'changedFrom',
        'increasedBy',
        'decreasedBy',
        'delta',
        'percentChange',
        'stableFor',
        'crossesAbove',
        'crossesBelow',
      ]),
      from: z.union([Scalar, z.null()]).optional(),
      to: z.union([Scalar, z.null()]).optional(),
      value: z.number().optional(),
      comparator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte'])
        .default('gte'),
      forMs: z.number().int().positive().optional(),
    }).strict().superRefine((value, ctx) => {
      if (
        value.op === 'changedFrom' &&
        (value.from === undefined || value.to === undefined)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'changedFrom requires from and to',
        });
      }
      if (
        ['increasedBy', 'decreasedBy', 'delta', 'percentChange', 'crossesAbove', 'crossesBelow']
          .includes(value.op) &&
        value.value === undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `${value.op} requires value`,
        });
      }
      if (value.op === 'stableFor' && value.forMs === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'stableFor requires forMs',
        });
      }
    }),

    z.object({
      kind: z.literal('semantic'),
      id: Id,
      child: PatternNodeV2Schema,
      refs: z.array(Id).min(1),
      instruction: z.string().min(1).max(4000),
      input: z.array(z.string().min(1)).min(1),
      matchThreshold: z.number().min(0).max(1),
      rejectThreshold: z.number().min(0).max(1),
      uncertain: z.enum(['escalate', 'reject', 'match']).default('escalate'),
      execution: z.object({
        cache: z.boolean().default(true),
        timeoutMs: z.number().int().positive().max(60000).default(5000),
        onUnavailable: z.enum(['error', 'reject']).default('error'),
      }).default({
        cache: true,
        timeoutMs: 5000,
        onUnavailable: 'error',
      }),
    }).strict().superRefine((value, ctx) => {
      if (value.rejectThreshold > value.matchThreshold) {
        ctx.addIssue({
          code: 'custom',
          message: 'semantic rejectThreshold cannot exceed matchThreshold',
        });
      }
    }),
  ]);

  return node;
});

export type PatternNodeV2 = z.infer<typeof PatternNodeV2Schema>;

export const PatternPartitionDimensionSchema = z.object({
  key: Id,
  fields: z.array(z.object({
    ref: Id,
    path: z.string().min(1),
  }).strict()).min(1),
}).strict();

export const PatternAfterMatchSchema = z.union([
  z.enum([
    'skipPastLast',
    'skipToNext',
    'keepAll',
  ]),
  z.object({
    kind: z.enum(['skipToFirst', 'skipToLast']),
    ref: Id,
  }).strict(),
]);

export const PatternSelectionSchema = z.object({
  overlap: z.enum(['allow', 'disallow']).default('disallow'),
  afterMatch: PatternAfterMatchSchema.default('skipPastLast'),
  maxMatchesPerEvent: z.number().int().min(1).max(100).default(10),
}).strict();

export const PatternExecutionPolicySchema = z.object({
  maxCandidates: z.number().int().min(1).max(10000).default(512),
  maxSemanticEvaluations: z.number().int().min(0).max(1000).default(16),
}).strict();

export const PatternMeasureSchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/),
  expression: z.union([
    PatternArithmeticValueSchema,
    z.object({
      kind: z.literal('aggregate'),
      function: AggregateFunctionSchema,
      ref: Id,
      path: z.string().min(1).optional(),
      nth: z.number().int().min(0).optional(),
      percentile: z.number().min(0).max(1).optional(),
    }).strict().superRefine((value, ctx) => {
      if (
        value.function !== 'count' &&
        !value.path
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `${value.function} measure requires path`,
        });
      }
      if (value.function === 'nth' && value.nth === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'nth measure requires nth',
        });
      }
      if (
        value.function === 'percentile' &&
        value.percentile === undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'percentile measure requires percentile',
        });
      }
    }),
  ]),
}).strict();

export const PatternAstV2DefinitionSchema = z.object({
  version: z.literal(PATTERN_AST_VERSION).default(PATTERN_AST_VERSION),
  root: PatternNodeV2Schema,
  partitionBy: z.array(PatternPartitionDimensionSchema).default([]),
  selection: PatternSelectionSchema.default({
    overlap: 'disallow',
    afterMatch: 'skipPastLast',
    maxMatchesPerEvent: 10,
  }),
  execution: PatternExecutionPolicySchema.default({
    maxCandidates: 512,
    maxSemanticEvaluations: 16,
  }),
}).strict();

export type PatternAfterMatch = z.infer<typeof PatternAfterMatchSchema>;
export type PatternAstV2Definition =
  z.infer<typeof PatternAstV2DefinitionSchema>;
export type PatternMeasure = z.infer<typeof PatternMeasureSchema>;

export function collectPatternMeasureRefs(
  measure: PatternMeasure,
): string[] {
  const refs = new Set<string>();
  const visitValue = (value: PatternArithmeticValue) => {
    if (value.kind === 'field' || value.kind === 'occurredAt') {
      refs.add(value.ref);
      return;
    }
    if (value.kind === 'arithmetic') {
      value.args.forEach((arg: PatternArithmeticValue) => visitValue(arg));
    }
  };

  if (measure.expression.kind === 'aggregate') {
    refs.add(measure.expression.ref);
  } else {
    visitValue(measure.expression);
  }

  return [...refs];
}

export function collectPatternDurationsMs(
  node: PatternNodeV2,
): number[] {
  const durations: number[] = [];

  const visit = (current: PatternNodeV2) => {
    if (current.kind === 'window') {
      if (
        current.window.type === 'within' ||
        current.window.type === 'sliding' ||
        current.window.type === 'tumbling' ||
        current.window.type === 'hopping'
      ) {
        durations.push(current.window.sizeMs);
      } else if (current.window.type === 'session') {
        durations.push(current.window.gapMs);
      }
      visit(current.child);
      return;
    }

    if (current.kind === 'notFollowedBy') {
      durations.push(current.withinMs);
      visit(current.child);
      visit(current.forbidden);
      return;
    }

    if (current.kind === 'absence') {
      if (current.forMs) durations.push(current.forMs);
      visit(current.child);
      return;
    }

    if (current.kind === 'debounce') {
      durations.push(current.forMs);
      visit(current.child);
      return;
    }

    if (current.kind === 'rate') {
      durations.push(current.perMs);
      visit(current.child);
      return;
    }

    if (current.kind === 'state') {
      if (current.forMs) durations.push(current.forMs);
      visit(current.child);
      return;
    }

    if (
      current.kind === 'repeat' ||
      current.kind === 'optional' ||
      current.kind === 'calendar' ||
      current.kind === 'notPresent' ||
      current.kind === 'after' ||
      current.kind === 'until' ||
      current.kind === 'threshold' ||
      current.kind === 'distinct' ||
      current.kind === 'compare' ||
      current.kind === 'aggregate' ||
      current.kind === 'semantic'
    ) {
      visit(current.child);
      return;
    }

    if (current.kind === 'notNext') {
      visit(current.child);
      visit(current.forbidden);
      return;
    }

    if (
      current.kind === 'allOf' ||
      current.kind === 'anyOf' ||
      current.kind === 'sequence'
    ) {
      current.children.forEach(visit);
    }
  };

  visit(node);
  return durations;
}

export function collectPatternRefs(node: PatternNodeV2): string[] {
  const refs = new Set<string>();

  const visitValue = (value: PatternArithmeticValue) => {
    if (value.kind === 'field' || value.kind === 'occurredAt') {
      refs.add(value.ref);
      return;
    }
    if (value.kind === 'arithmetic') {
      for (const arg of value.args) visitValue(arg);
    }
  };

  const visit = (current: PatternNodeV2) => {
    switch (current.kind) {
      case 'event':
        refs.add(current.ref);
        return;
      case 'allOf':
      case 'anyOf':
      case 'sequence':
        current.children.forEach(visit);
        return;
      case 'repeat':
      case 'optional':
      case 'window':
        visit(current.child);
        return;
      case 'calendar':
      case 'notPresent':
      case 'threshold':
      case 'rate':
      case 'distinct':
        visit(current.child);
        refs.add(current.ref);
        return;
      case 'absence':
        visit(current.child);
        refs.add(current.ref);
        refs.add(current.afterRef);
        return;
      case 'after':
        visit(current.child);
        refs.add(current.ref);
        refs.add(current.afterRef);
        return;
      case 'until':
        visit(current.child);
        refs.add(current.ref);
        refs.add(current.beforeRef);
        return;
      case 'debounce':
        visit(current.child);
        refs.add(current.ref);
        return;
      case 'notNext':
      case 'notFollowedBy':
        visit(current.child);
        visit(current.forbidden);
        return;
      case 'compare':
        visit(current.child);
        visitValue(current.left);
        if (current.right) visitValue(current.right);
        return;
      case 'aggregate':
      case 'state':
        visit(current.child);
        refs.add(current.ref);
        return;
      case 'semantic':
        visit(current.child);
        current.refs.forEach((ref: string) => refs.add(ref));
        return;
    }
  };

  visit(node);
  return [...refs];
}
