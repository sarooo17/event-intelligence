import { z } from 'zod';
import { ContinuationContractSchema } from './triggerSchemas.js';

const Id = z.string().min(1).max(200);
const Timestamp = z.string().datetime({ offset: true });

export const ActivationEvidenceSchema = z.object({
  clauseId: Id,
  serverId: Id.nullable(),
  eventId: Id,
  eventName: z.string().min(1),
  traceId: Id,
  occurredAt: Timestamp,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  data: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const ActivationEnvelopeSchema = z.object({
  activationVersion: z.literal('1'),
  wake: z.object({
    wakeId: Id,
    status: z.string().min(1),
    runtimeReceiptId: Id.nullable(),
    matchedAt: Timestamp,
  }).strict(),
  target: z.object({
    runtime: z.string().min(1),
    kind: z.string().min(1),
    id: Id,
  }).strict(),
  trigger: z.object({
    triggerId: Id,
    version: z.string().min(1),
    description: z.string().nullable(),
    expression: z.record(z.string(), z.unknown()),
    lifecycle: z.record(z.string(), z.unknown()),
  }).strict(),
  continuation: ContinuationContractSchema.nullable(),
  match: z.object({
    matchId: Id,
    status: z.string().min(1),
    correlationKey: z.string().nullable(),
    openedAt: Timestamp,
    updatedAt: Timestamp,
  }).strict(),
  evidence: z.array(ActivationEvidenceSchema),
  trust: z.object({
    continuation: z.literal('configured_trigger_instruction'),
    evidence: z.literal('untrusted_external_signal'),
  }).strict(),
}).strict();

export type ActivationEvidence = z.infer<typeof ActivationEvidenceSchema>;
export type ActivationEnvelope = z.infer<typeof ActivationEnvelopeSchema>;

export function parseActivationEnvelope(value: unknown): ActivationEnvelope {
  return ActivationEnvelopeSchema.parse(value);
}
