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
  // Host-owned continuation kind. Event Intelligence persists and returns
  // this opaque discriminator; it must not encode one runtime's task model.
  kind: z.string().min(1).max(100),
  id: Id,
});

export const WakeRecordSchema = z.object({
  wakeId: Id,
  traceId: Id,
  decisionId: Id.nullable(),
  subscriptionId: Id,
  sourceEventId: Id,
  createdAt: Timestamp,
  target: RuntimeTargetSchema,
  status: z.enum(['queued', 'delivered', 'dead_letter']),
  runtimeReceiptId: Id.optional(),
});



export const McpEventOccurrenceSchema = z.object({
  eventId: Id,
  name: z.string().min(1),
  timestamp: Timestamp,
  data: z.record(z.string(), z.unknown()),
  cursor: z.string().nullable().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

export const LifecycleStateSchema = z.enum([
  'wake_queued',
  'wake_delivered',
  'dead_letter',
]);

export const AuditKindSchema = z.enum([
  'event.late_dropped',
  'event.buffer_overflow',
  'wake.queued',
  'wake.delivered',
  'wake.retry_scheduled',
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
export type WakeRecord = z.infer<typeof WakeRecordSchema>;
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export function parseWakeRecord(value: unknown): WakeRecord {
  return WakeRecordSchema.parse(value);
}

export function parseAuditRecord(value: unknown): AuditRecord {
  return AuditRecordSchema.parse(value);
}