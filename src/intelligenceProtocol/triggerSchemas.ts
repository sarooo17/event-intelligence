import { z } from 'zod';
import { RuntimeTargetSchema } from './schemas.js';
import {
  PatternAstV2DefinitionSchema,
  PatternMeasureSchema,
  collectPatternDurationsMs,
  collectGuaranteedPatternBindings,
  collectPatternMeasureRefs,
  collectPatternRefs,
} from './patternV2Schemas.js';

export const COMPOSITE_TRIGGER_PROTOCOL_VERSION = '0.1.0' as const;
export const COMPOSITE_TRIGGER_SCHEMA_VERSION = 'trigger.v0.1' as const;

const Id = z.string().min(1).max(200);
const Timestamp = z.string().datetime({ offset: true });
const Scalar = z.union([z.string(), z.number(), z.boolean()]);
const ClockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const StructuredPredicateSchema = z.discriminatedUnion('op', [
  z.object({ path: z.string().min(1), op: z.literal('eq'), value: Scalar }),
  z.object({ path: z.string().min(1), op: z.literal('neq'), value: Scalar }),
  z.object({ path: z.string().min(1), op: z.literal('contains'), value: Scalar }),
  z.object({ path: z.string().min(1), op: z.literal('startsWith'), value: z.string() }),
  z.object({ path: z.string().min(1), op: z.literal('endsWith'), value: z.string() }),
  z.object({
    path: z.string().min(1),
    op: z.literal('regex'),
    value: z.string(),
    flags: z.string().max(10).optional(),
  }),
  z.object({ path: z.string().min(1), op: z.literal('in'), value: z.array(Scalar).min(1) }),
  z.object({ path: z.string().min(1), op: z.literal('notIn'), value: z.array(Scalar).min(1) }),
  z.object({
    path: z.string().min(1),
    op: z.literal('between'),
    value: z.tuple([Scalar, Scalar]),
  }),
  z.object({ path: z.string().min(1), op: z.literal('exists'), value: z.boolean().default(true) }),
  z.object({ path: z.string().min(1), op: z.literal('isNull'), value: z.boolean().default(true) }),
  z.object({
    path: z.string().min(1),
    op: z.literal('type'),
    value: z.enum(['string', 'number', 'boolean', 'null', 'object', 'array']),
  }),
  z.object({ path: z.string().min(1), op: z.literal('gt'), value: z.number() }),
  z.object({ path: z.string().min(1), op: z.literal('gte'), value: z.number() }),
  z.object({ path: z.string().min(1), op: z.literal('lt'), value: z.number() }),
  z.object({ path: z.string().min(1), op: z.literal('lte'), value: z.number() }),
]);

export const TriggerClauseSchema = z.object({
  id: Id,
  event: z.string().min(1),
  serverId: Id.optional(),
  contractVersion: z.string().min(1).max(50).optional(),
  arguments: z.record(z.string(), z.unknown()).default({}),
  where: z.array(StructuredPredicateSchema).default([]),
});

const TriggerExpressionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allOf'), refs: z.array(Id).min(2) }),
  z.object({ kind: z.literal('anyOf'), refs: z.array(Id).min(1) }),
  z.object({ kind: z.literal('sequence'), refs: z.array(Id).min(2) }),
  z.object({ kind: z.literal('count'), ref: Id, atLeast: z.number().int().min(1) }),
]);

export const CalendarTemporalConditionSchema = z.object({
  id: Id,
  kind: z.literal('calendar'),
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
}).strict();

export const AbsenceTemporalConditionSchema = z.object({
  id: Id,
  kind: z.literal('absence'),
  ref: Id,
  afterRef: Id,
  forMs: z.number().int().positive().optional(),
  untilLocalTime: ClockTime.optional(),
  timezone: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
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
});

export const TemporalConditionSchema = z.discriminatedUnion('kind', [
  CalendarTemporalConditionSchema,
  AbsenceTemporalConditionSchema,
  z.object({ id: Id, kind: z.literal('not'), ref: Id }),
  z.object({ id: Id, kind: z.literal('unless'), ref: Id }),
  z.object({ id: Id, kind: z.literal('after'), ref: Id, afterRef: Id }),
  z.object({ id: Id, kind: z.literal('until'), ref: Id, beforeRef: Id }),
  z.object({
    id: Id,
    kind: z.literal('debounce'),
    ref: Id,
    forMs: z.number().int().positive(),
  }),
  z.object({
    id: Id,
    kind: z.literal('threshold'),
    ref: Id,
    atLeast: z.number().int().min(1),
  }),
  z.object({
    id: Id,
    kind: z.literal('rate'),
    ref: Id,
    atLeast: z.number().int().min(1),
    perMs: z.number().int().positive(),
  }),
  z.object({
    id: Id,
    kind: z.literal('distinct'),
    ref: Id,
    path: z.string().min(1),
    atLeast: z.number().int().min(1),
  }),
]);

export const DerivedEventProjectionSchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/),
  ref: Id,
  path: z.string().min(1),
}).strict();

export const DerivedEventDefinitionSchema = z.object({
  name: z.string().min(1).max(200),
  contractVersion: z.string().min(1).max(50),
  projections: z.array(DerivedEventProjectionSchema).max(32).default([]),
  constants: z.record(z.string(), Scalar).default({}),
  measures: z.array(PatternMeasureSchema).max(32).default([]),
}).strict();

export const DerivedEventEvidenceRefSchema = z.object({
  serverId: Id.nullable(),
  eventName: z.string().min(1),
  sourceEventId: Id,
  traceId: Id,
  occurredAt: Timestamp,
  receivedAt: Timestamp.optional(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  contractVersion: z.string().min(1).nullable().optional(),
  schemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
}).strict();

export const EventTimePolicySchema = z.object({
  allowedLatenessMs: z.number().int().nonnegative()
    .max(1000 * 60 * 60 * 24 * 30),
}).strict();

export const TriggerLifecyclePolicySchema = z.object({
  oneShot: z.boolean().default(false),
  maxFirings: z.number().int().min(1).optional(),
  cooldownMs: z.number().int().nonnegative().default(0),
  expiresAt: Timestamp.optional(),
  leaseUntil: Timestamp.optional(),
  completeOnGoal: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.oneShot && value.maxFirings && value.maxFirings !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'oneShot is incompatible with maxFirings other than 1',
    });
  }
  if (
    value.expiresAt &&
    value.leaseUntil &&
    Date.parse(value.leaseUntil) > Date.parse(value.expiresAt)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'leaseUntil cannot be after expiresAt',
    });
  }
});

export const ContinuationContextPolicySchema = z.object({
  evidence: z.enum(['matched_events', 'refs_only']).default('matched_events'),
  maxEvents: z.number().int().min(1).max(50).default(50),
  includeData: z.boolean().default(true),
}).strict();

export const ContinuationContractSchema = z.object({
  instruction: z.string().min(1).max(4000),
  contextPolicy: ContinuationContextPolicySchema.default({
    evidence: 'matched_events',
    maxEvents: 50,
    includeData: true,
  }),
}).strict();

export const DeterministicCorrelationSchema = z.object({
  kind: z.literal('same_value'),
  fields: z.array(z.object({
    ref: Id,
    path: z.string().min(1),
  })).min(2),
});

export const SemanticCorrelationSchema = z.object({
  instruction: z.string().min(1),
  input: z.array(z.string().min(1)).min(1),
  matchThreshold: z.number().min(0).max(1),
  rejectThreshold: z.number().min(0).max(1),
  uncertain: z.enum(['escalate', 'reject', 'match']).default('escalate'),
});

export const CompositeTriggerDefinitionSchema = z.object({
  protocolVersion: z.literal(COMPOSITE_TRIGGER_PROTOCOL_VERSION)
    .default(COMPOSITE_TRIGGER_PROTOCOL_VERSION),
  schemaVersion: z.literal(COMPOSITE_TRIGGER_SCHEMA_VERSION)
    .default(COMPOSITE_TRIGGER_SCHEMA_VERSION),
  triggerId: Id,
  version: z.string().min(1),
  description: z.string().max(500).optional(),
  conditionOnly: z.boolean().default(false),
  continuation: ContinuationContractSchema.optional(),
  clauses: z.array(TriggerClauseSchema).min(1),
  expression: TriggerExpressionSchema,
  temporal: z.array(TemporalConditionSchema).default([]),
  patternV2: PatternAstV2DefinitionSchema.optional(),
  eventTime: EventTimePolicySchema.optional(),
  lifecycle: TriggerLifecyclePolicySchema.default({
    oneShot: false,
    cooldownMs: 0,
    completeOnGoal: false,
  }),
  withinMs: z.number().int().positive().max(1000 * 60 * 60 * 24 * 30),
  correlation: z.object({
    deterministic: DeterministicCorrelationSchema.optional(),
    semantic: SemanticCorrelationSchema.optional(),
  }).optional(),
  target: RuntimeTargetSchema.optional(),
  derivedEvent: DerivedEventDefinitionSchema.optional(),
}).superRefine((value, ctx) => {
  if (!value.target && !value.derivedEvent && !value.conditionOnly) {
    ctx.addIssue({
      code: 'custom',
      message: 'Trigger requires target, derivedEvent, or conditionOnly=true',
    });
  }
  if (
    value.conditionOnly &&
    (value.target || value.derivedEvent || value.continuation)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'conditionOnly triggers cannot declare target, derivedEvent, or continuation',
    });
  }
  if (
    value.conditionOnly &&
    (
      value.lifecycle.oneShot ||
      value.lifecycle.maxFirings !== undefined ||
      value.lifecycle.cooldownMs > 0 ||
      value.lifecycle.completeOnGoal
    )
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'conditionOnly triggers cannot use effect-based lifecycle fields',
    });
  }
  if (value.continuation && !value.target) {
    ctx.addIssue({
      code: 'custom',
      message: 'Trigger continuation requires a runtime target',
    });
  }
  const ids = new Set(value.clauses.map((clause) => clause.id));
  if (ids.size !== value.clauses.length) {
    ctx.addIssue({ code: 'custom', message: 'Trigger clause ids must be unique' });
  }

  const refs =
    value.expression.kind === 'count'
      ? [value.expression.ref]
      : value.expression.refs;

  for (const ref of refs) {
    if (!ids.has(ref)) {
      ctx.addIssue({
        code: 'custom',
        message: `Expression references unknown clause: ${ref}`,
      });
    }
  }

  for (const field of value.correlation?.deterministic?.fields ?? []) {
    if (!ids.has(field.ref)) {
      ctx.addIssue({
        code: 'custom',
        message: `Correlation references unknown clause: ${field.ref}`,
      });
    }
  }

  if (value.derivedEvent) {
    const projectionKeys = new Set();
    const measureKeys = new Set();

    for (const measure of value.derivedEvent.measures ?? []) {
      if (measure.key === '_derived') {
        ctx.addIssue({
          code: 'custom',
          message: 'Derived event measure key _derived is reserved',
        });
      }
      if (measureKeys.has(measure.key)) {
        ctx.addIssue({
          code: 'custom',
          message: `Derived event measure key must be unique: ${measure.key}`,
        });
      }
      if (Object.prototype.hasOwnProperty.call(
        value.derivedEvent.constants,
        measure.key,
      )) {
        ctx.addIssue({
          code: 'custom',
          message: `Derived event key cannot be both constant and measure: ${measure.key}`,
        });
      }
      for (const ref of collectPatternMeasureRefs(measure)) {
        if (!ids.has(ref)) {
          ctx.addIssue({
            code: 'custom',
            message: `Derived event measure ${measure.key} references unknown clause: ${ref}`,
          });
        }
      }
      measureKeys.add(measure.key);
    }

    for (const projection of value.derivedEvent.projections) {
      if (!ids.has(projection.ref)) {
        ctx.addIssue({
          code: 'custom',
          message: `Derived event projection references unknown clause: ${projection.ref}`,
        });
      }
      if (measureKeys.has(projection.key)) {
        ctx.addIssue({
          code: 'custom',
          message: `Derived event key cannot be both measure and projection: ${projection.key}`,
        });
      }
      if (projectionKeys.has(projection.key)) {
        ctx.addIssue({
          code: 'custom',
          message: `Derived event projection key must be unique: ${projection.key}`,
        });
      }
      if (projection.key === '_derived') {
        ctx.addIssue({
          code: 'custom',
          message: 'Derived event projection key _derived is reserved',
        });
      }
      if (Object.prototype.hasOwnProperty.call(
        value.derivedEvent.constants,
        projection.key,
      )) {
        ctx.addIssue({
          code: 'custom',
          message: `Derived event key cannot be both constant and projection: ${projection.key}`,
        });
      }
      projectionKeys.add(projection.key);
    }
    if (Object.prototype.hasOwnProperty.call(value.derivedEvent.constants, '_derived')) {
      ctx.addIssue({
        code: 'custom',
        message: 'Derived event constant key _derived is reserved',
      });
    }
  }

  if (value.patternV2) {
    const patternRefs = collectPatternRefs(value.patternV2.root);
    for (const ref of patternRefs) {
      if (!ids.has(ref)) {
        ctx.addIssue({
          code: 'custom',
          message: `Pattern AST v2 references unknown clause: ${ref}`,
        });
      }
    }

    for (const dimension of value.patternV2.partitionBy) {
      const dimensionRefs = new Set();
      for (const field of dimension.fields) {
        if (!ids.has(field.ref)) {
          ctx.addIssue({
            code: 'custom',
            message: `Pattern partition ${dimension.key} references unknown clause: ${field.ref}`,
          });
        }
        if (dimensionRefs.has(field.ref)) {
          ctx.addIssue({
            code: 'custom',
            message: `Pattern partition ${dimension.key} has duplicate field mapping for ${field.ref}`,
          });
        }
        dimensionRefs.add(field.ref);
      }

      for (const ref of patternRefs) {
        if (!dimensionRefs.has(ref)) {
          ctx.addIssue({
            code: 'custom',
            message: `Pattern partition ${dimension.key} does not map pattern ref: ${ref}`,
          });
        }
      }
    }

    const guaranteedPatternRefs =
      collectGuaranteedPatternBindings(value.patternV2.root);

    if (
      typeof value.patternV2.selection.afterMatch === 'object' &&
      !guaranteedPatternRefs.includes(
        value.patternV2.selection.afterMatch.ref,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          `Pattern afterMatch ref is not guaranteed by every match: ${value.patternV2.selection.afterMatch.ref}`,
      });
    }

    for (const measure of value.derivedEvent?.measures ?? []) {
      for (const ref of collectPatternMeasureRefs(measure)) {
        if (!guaranteedPatternRefs.includes(ref)) {
          ctx.addIssue({
            code: 'custom',
            message:
              `Derived measure ${measure.key} references non-guaranteed pattern ref: ${ref}`,
          });
        }
      }
    }

    const oversized = collectPatternDurationsMs(value.patternV2.root)
      .filter((duration) => duration > value.withinMs);
    if (oversized.length) {
      ctx.addIssue({
        code: 'custom',
        message:
          `Pattern AST v2 duration exceeds trigger withinMs: ${Math.max(...oversized)} > ${value.withinMs}`,
      });
    }
  }

  const conditionIds = new Set();
  for (const condition of value.temporal) {
    if (conditionIds.has(condition.id)) {
      ctx.addIssue({
        code: 'custom',
        message: `Temporal condition id must be unique: ${condition.id}`,
      });
    }
    conditionIds.add(condition.id);

    const conditionRefs = [];
    if ('ref' in condition) conditionRefs.push(condition.ref);
    if ('afterRef' in condition) conditionRefs.push(condition.afterRef);
    if ('beforeRef' in condition) conditionRefs.push(condition.beforeRef);
    for (const ref of conditionRefs) {
      if (!ids.has(ref)) {
        ctx.addIssue({
          code: 'custom',
          message: `Temporal condition ${condition.id} references unknown clause: ${ref}`,
        });
      }
    }

    if (condition.kind === 'calendar') {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: condition.timezone });
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid IANA timezone: ${condition.timezone}`,
        });
      }
      if (
        condition.before &&
        condition.after &&
        condition.before === condition.after
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'calendar before and after cannot be identical',
        });
      }
    }

    if (
      condition.kind === 'absence' &&
      condition.timezone
    ) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: condition.timezone });
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid IANA timezone: ${condition.timezone}`,
        });
      }
    }
  }
});

export const CorrelatableEventSchema = z.object({
  traceId: Id,
  sourceEventId: Id,
  name: z.string().min(1),
  occurredAt: Timestamp,
  receivedAt: Timestamp.optional(),
  provider: z.string().min(1).optional(),
  serverId: Id.optional(),
  subscriptionArguments: z.record(z.string(), z.unknown()).default({}),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  data: z.record(z.string(), z.unknown()),
});

export const DerivedEventRecordSchema = z.object({
  event: CorrelatableEventSchema,
  triggerId: Id,
  triggerVersion: z.string().min(1),
  matchId: Id,
  directParents: z.array(DerivedEventEvidenceRefSchema).min(1),
  rootEvidence: z.array(DerivedEventEvidenceRefSchema).min(1),
  createdAt: Timestamp,
}).strict();

export const TriggerSourceEventSchema = z.object({
  clauseId: Id,
  traceId: Id,
  sourceEventId: Id,
  eventName: z.string().min(1),
  occurredAt: Timestamp,
  receivedAt: Timestamp.optional(),
  provider: z.string().min(1).optional(),
  serverId: Id.optional(),
  subscriptionArguments: z.record(z.string(), z.unknown()).default({}),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  data: z.record(z.string(), z.unknown()),
});

export const CompositeCorrelationDecisionSchema = z.object({
  evaluator: z.string().min(1),
  outcome: z.enum(['match', 'reject', 'uncertain']),
  probability: z.number().min(0).max(1),
  matched: z.boolean(),
  shouldEscalate: z.boolean(),
  inputFields: z.array(z.string().min(1)),
  providerEvidence: z.record(z.string(), z.unknown()).optional(),
  evaluatedAt: Timestamp,
});

export const TriggerMatchStatusSchema = z.enum([
  'partial',
  'matched',
  'emitted',
  'fired',
  'expired',
]);

export const PatternMatchStateSchema = z.object({
  version: z.literal('2'),
  role: z.enum(['buffer', 'match']),
  signature: z.string().min(1).optional(),
  maxObservedOccurredAt: Timestamp.optional(),
  semanticDecisions: z.array(z.object({
    nodeId: Id,
    decision: CompositeCorrelationDecisionSchema,
  }).strict()).default([]),
}).strict();

export const TriggerMatchRecordSchema = z.object({
  protocolVersion: z.literal(COMPOSITE_TRIGGER_PROTOCOL_VERSION),
  schemaVersion: z.literal(COMPOSITE_TRIGGER_SCHEMA_VERSION),
  matchId: Id,
  triggerId: Id,
  triggerVersion: z.string().min(1),
  status: TriggerMatchStatusSchema,
  correlationKey: z.string().nullable(),
  openedAt: Timestamp,
  expiresAt: Timestamp,
  updatedAt: Timestamp,
  sourceEvents: z.array(TriggerSourceEventSchema),
  correlationDecision: CompositeCorrelationDecisionSchema.nullable(),
  patternState: PatternMatchStateSchema.optional(),
  firedWakeId: Id.nullable(),
  derivedEventIds: z.array(Id).default([]),
});

export type StructuredPredicate = z.infer<typeof StructuredPredicateSchema>;
export type TriggerClause = z.infer<typeof TriggerClauseSchema>;
export type TemporalCondition = z.infer<typeof TemporalConditionSchema>;
export type EventTimePolicy = z.infer<typeof EventTimePolicySchema>;
export type TriggerLifecyclePolicy = z.infer<typeof TriggerLifecyclePolicySchema>;
export type ContinuationContextPolicy = z.infer<typeof ContinuationContextPolicySchema>;
export type ContinuationContract = z.infer<typeof ContinuationContractSchema>;
export type DerivedEventDefinition = z.infer<typeof DerivedEventDefinitionSchema>;
export type DerivedEventRecord = z.infer<typeof DerivedEventRecordSchema>;
export type CompositeTriggerDefinition = z.infer<typeof CompositeTriggerDefinitionSchema>;
export type CorrelatableEvent = z.infer<typeof CorrelatableEventSchema>;
export type TriggerSourceEvent = z.infer<typeof TriggerSourceEventSchema>;
export type PatternMatchState = z.infer<typeof PatternMatchStateSchema>;
export type TriggerMatchRecord = z.infer<typeof TriggerMatchRecordSchema>;
export type CompositeCorrelationDecision = z.infer<typeof CompositeCorrelationDecisionSchema>;

export function parseCompositeTriggerDefinition(
  value: unknown,
): CompositeTriggerDefinition {
  return CompositeTriggerDefinitionSchema.parse(value);
}

export function parseCorrelatableEvent(value: unknown): CorrelatableEvent {
  return CorrelatableEventSchema.parse(value);
}

export function parseTriggerMatchRecord(value: unknown): TriggerMatchRecord {
  return TriggerMatchRecordSchema.parse(value);
}

export function parseDerivedEventRecord(value: unknown): DerivedEventRecord {
  return DerivedEventRecordSchema.parse(value);
}
