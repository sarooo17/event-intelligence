import { z } from 'zod';
import {
  EVENT_INTELLIGENCE_PROTOCOL,
  EVENT_INTELLIGENCE_PROTOCOL_VERSION,
  EVENT_INTELLIGENCE_SCHEMA_VERSION,
} from './version.js';

const Id = z.string().min(1).max(200);
const Timestamp = z.string().datetime({ offset: true });

export const RuntimeTargetSchema = z.object({
  runtime: z.string().min(1),
  kind: z.enum(['goal', 'session', 'conversation', 'task', 'spawn_template']),
  id: Id,
});

export const EventSourceSchema = z.object({
  serverId: Id,
  transport: z.enum(['stdio', 'streamable_http', 'webhook', 'poll', 'internal']),
  provider: z.string().min(1).optional(),
  cursor: z.string().nullable().optional(),
});

export const EventLineageSchema = z.object({
  protocol: z.literal(EVENT_INTELLIGENCE_PROTOCOL),
  protocolVersion: z.literal(EVENT_INTELLIGENCE_PROTOCOL_VERSION),
  schemaVersion: z.literal(EVENT_INTELLIGENCE_SCHEMA_VERSION),
  traceId: Id,
  environmentId: Id,
  subscriptionId: Id,
  sourceEventId: Id,
  observedAt: Timestamp,
  source: EventSourceSchema,
  target: RuntimeTargetSchema,
  event: z.object({
    name: z.string().min(1),
    occurredAt: Timestamp,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

export const SemanticDecisionRecordSchema = z.object({
  decisionId: Id,
  traceId: Id,
  subscriptionId: Id,
  sourceEventId: Id,
  createdAt: Timestamp,
  evaluator: z.string().min(1),
  outcome: z.enum(['match', 'reject', 'uncertain']),
  probability: z.number().min(0).max(1),
  matched: z.boolean(),
  shouldEscalate: z.boolean(),
  policy: z.object({
    matchThreshold: z.number().min(0).max(1),
    rejectThreshold: z.number().min(0).max(1),
    uncertain: z.enum(['escalate', 'reject', 'match']),
  }),
  inputFields: z.array(z.string().min(1)),
  providerEvidence: z.object({
    requestedModel: z.string().min(1).optional(),
    resolvedModel: z.string().min(1).optional(),
    requestId: z.string().min(1).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    providerReportedCost: z.number().nonnegative().optional(),
  }).optional(),
});

export const WakeRecordSchema = z.object({
  wakeId: Id,
  traceId: Id,
  decisionId: Id.nullable(),
  subscriptionId: Id,
  sourceEventId: Id,
  createdAt: Timestamp,
  target: RuntimeTargetSchema,
  status: z.enum(['queued', 'delivered', 'handled', 'duplicate', 'dead_letter']),
  runtimeReceiptId: Id.optional(),
});



export const McpEventOccurrenceSchema = z.object({
  eventId: Id,
  name: z.string().min(1),
  timestamp: Timestamp,
  data: z.record(z.string(), z.unknown()),
  cursor: z.string().nullable().optional(),
});

export const SemanticConditionWireSchema = z.object({
  type: z.literal('semantic_boolean'),
  instruction: z.string().min(1),
  input: z.array(z.string().min(1)).min(1),
  matchThreshold: z.number().min(0).max(1),
  rejectThreshold: z.number().min(0).max(1),
  uncertain: z.enum(['escalate', 'reject', 'match']),
});

export const EventIngestRequestSchema = z.object({
  event: McpEventOccurrenceSchema,
  context: z.object({
    traceId: Id.optional(),
    environmentId: Id,
    subscriptionId: Id,
    serverId: Id,
    transport: z.enum(['stdio', 'streamable_http', 'webhook', 'poll', 'internal']),
    provider: z.string().min(1).optional(),
    target: RuntimeTargetSchema,
  }),
  semanticCondition: SemanticConditionWireSchema.optional(),
  wakeOnEscalation: z.boolean().default(false),
});

export const LifecycleStateSchema = z.enum([
  'received',
  'duplicate',
  'evaluating',
  'matched',
  'rejected',
  'escalated',
  'wake_queued',
  'wake_delivered',
  'handled',
  'failed',
  'dead_letter',
]);

export const AuditKindSchema = z.enum([
  'event.received',
  'event.duplicate',
  'decision.evaluated',
  'lifecycle.transition',
  'wake.queued',
  'wake.delivered',
  'wake.handled',
  'wake.dead_letter',
  'trigger.partial',
  'trigger.correlation',
  'trigger.matched',
  'trigger.fired',
  'trigger.emitted',
  'trigger.expired',
  'trigger.created',
  'trigger.paused',
  'trigger.resumed',
  'trigger.updated',
  'trigger.deleted',
  'trigger.completed',
  'trigger.lifecycle_expired',
  'event_source.registered',
  'derived_event.created',
  'derived_event.replayed',
  'derived_contract.created',
  'derived_contract.producer_registered',
  'derived_contract.conflict',
  'error',
]);

export const AuditRecordSchema = z.object({
  auditId: Id,
  sequence: z.number().int().nonnegative(),
  traceId: Id,
  timestamp: Timestamp,
  kind: AuditKindSchema,
  entityType: z.enum([
    'event',
    'decision',
    'wake',
    'subscription',
    'runtime',
    'trigger_match',
    'trigger',
    'event_source',
    'derived_event',
    'derived_contract',
  ]),
  entityId: Id,
  fromState: LifecycleStateSchema.nullable().optional(),
  toState: LifecycleStateSchema.nullable().optional(),
  details: z.record(z.string(), z.unknown()).default({}),
  previousHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type RuntimeTarget = z.infer<typeof RuntimeTargetSchema>;
export type McpEventOccurrence = z.infer<typeof McpEventOccurrenceSchema>;
export type SemanticConditionWire = z.infer<typeof SemanticConditionWireSchema>;
export type EventIngestRequest = z.infer<typeof EventIngestRequestSchema>;
export type EventLineage = z.infer<typeof EventLineageSchema>;
export type SemanticDecisionRecord = z.infer<typeof SemanticDecisionRecordSchema>;
export type WakeRecord = z.infer<typeof WakeRecordSchema>;
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export function parseEventIngestRequest(value: unknown): EventIngestRequest {
  return EventIngestRequestSchema.parse(value);
}

export function parseEventLineage(value: unknown): EventLineage {
  return EventLineageSchema.parse(value);
}

export function parseSemanticDecisionRecord(value: unknown): SemanticDecisionRecord {
  return SemanticDecisionRecordSchema.parse(value);
}

export function parseWakeRecord(value: unknown): WakeRecord {
  return WakeRecordSchema.parse(value);
}

export function parseAuditRecord(value: unknown): AuditRecord {
  return AuditRecordSchema.parse(value);
}
