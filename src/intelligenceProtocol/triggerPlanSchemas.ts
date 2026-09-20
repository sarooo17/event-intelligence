import { z } from 'zod';
import { RuntimeTargetSchema } from './schemas.js';
import {
  ContinuationContractSchema,
  SemanticCorrelationSchema,
  StructuredPredicateSchema,
  TriggerLifecyclePolicySchema,
} from './triggerSchemas.js';

const Id = z.string().min(1).max(200);

export const TriggerPlanEventSchema = z.object({
  id: Id.optional(),
  event: z.string().min(1),
  serverId: Id.optional(),
  where: z.array(StructuredPredicateSchema).default([]),
}).strict();

export const TriggerPlanMatchSchema = z.union([
  z.enum(['all', 'any', 'sequence']),
  z.object({
    kind: z.literal('count'),
    eventId: Id,
    atLeast: z.number().int().min(1),
  }).strict(),
]);

export const TriggerPlanInputSchema = z.object({
  triggerId: Id.optional(),
  version: z.string().min(1).default('1'),
  description: z.string().max(500).optional(),
  events: z.array(TriggerPlanEventSchema).min(1),
  match: TriggerPlanMatchSchema.default('all'),
  withinMs: z.number().int().positive().max(1000 * 60 * 60 * 24 * 30)
    .default(60 * 60 * 1000),
  lifecycle: TriggerLifecyclePolicySchema.partial().optional(),
  target: RuntimeTargetSchema,
  continuation: ContinuationContractSchema,
  correlateBy: z.array(z.object({
    eventId: Id,
    path: z.string().min(1),
  }).strict()).min(2).optional(),
  semanticCorrelation: SemanticCorrelationSchema.optional(),
}).strict();

export type TriggerPlanEvent = z.infer<typeof TriggerPlanEventSchema>;
export type TriggerPlanMatch = z.infer<typeof TriggerPlanMatchSchema>;
export type TriggerPlanInput = z.infer<typeof TriggerPlanInputSchema>;

export function parseTriggerPlanInput(value: unknown): TriggerPlanInput {
  return TriggerPlanInputSchema.parse(value);
}
