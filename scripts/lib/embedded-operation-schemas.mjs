import { z } from 'zod';

// This is the single source of truth for the embedded host-neutral tool
// arguments. MCP stdio has a deliberately different projection (#43).
const TriggerClauseInput = z.object({
  id: z.string().min(1).max(200).optional(),
  event: z.string().min(1).max(200),
  serverId: z.string().min(1).max(200).optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  where: z.array(z.record(z.string(), z.unknown())).max(32).optional(),
}).strict();

export const TriggerCreateInput = z.object({
  trigger_id: z.string().min(1).max(200).optional(),
  version: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  events: z.array(TriggerClauseInput).min(1).max(32),
  pattern: z.record(z.string(), z.unknown()).optional(),
  within_ms: z.number().int().positive().max(30 * 24 * 60 * 60 * 1000)
    .optional(),
  event_time: z.object({
    allowed_lateness_ms: z.number().int().nonnegative()
      .max(30 * 24 * 60 * 60 * 1000),
  }).strict().optional(),
  instruction: z.string().min(1).max(4000),
  one_shot: z.boolean().optional(),
  max_firings: z.number().int().min(1).optional(),
  cooldown_ms: z.number().int().nonnegative().optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
  lease_until: z.string().datetime({ offset: true }).optional(),
  complete_on_goal: z.boolean().optional(),
}).strict();

export const TriggerListInput = z.object({
  status: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(16)]).optional(),
  trigger_id: z.string().min(1).max(200).optional(),
  version: z.string().min(1).max(100).optional(),
  connection_id: z.string().min(1).max(200).optional(),
  event: z.string().min(1).max(200).optional(),
  target_runtime: z.string().min(1).max(200).optional(),
  target_kind: z.string().min(1).max(200).optional(),
  target_id: z.string().min(1).max(500).optional(),
  one_shot: z.boolean().optional(),
  remaining_only: z.boolean().optional(),
  include_definition: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

export const TriggerInspectInput = z.object({
  trigger_id: z.string().min(1).max(200),
  version: z.string().min(1).max(100).optional(),
  match_id: z.string().min(1).max(200).optional(),
}).strict();

export const TriggerLifecycleInput = z.object({
  trigger_id: z.string().min(1).max(200),
  version: z.string().min(1).max(100).optional(),
}).strict();

export const TriggerUpdateInput = TriggerCreateInput.omit({
  trigger_id: true,
  version: true,
}).extend({
  trigger_id: z.string().min(1).max(200),
  expected_version: z.string().min(1).max(100).optional(),
  version: z.string().min(1).max(100).optional(),
}).strict();


/**
 * The public model-facing input schema is generated from the same Zod
 * validator used by the execution path. This prevents discrepancies in
 * required fields, nested clauses, regex formats, enum/union branches and
 * validation limits. Unlike hand-written JSON, every exposed operation has
 * one authoritative authoring grammar.
 */
export const EMBEDDED_INPUT_JSON_SCHEMAS = Object.freeze({
  sources: z.toJSONSchema(z.object({}).strict(), { io: 'input' }),
  create: z.toJSONSchema(TriggerCreateInput, { io: 'input' }),
  list: z.toJSONSchema(TriggerListInput, { io: 'input' }),
  inspect: z.toJSONSchema(TriggerInspectInput, { io: 'input' }),
  pause: z.toJSONSchema(TriggerLifecycleInput, { io: 'input' }),
  resume: z.toJSONSchema(TriggerLifecycleInput, { io: 'input' }),
  delete: z.toJSONSchema(TriggerLifecycleInput, { io: 'input' }),
  update: z.toJSONSchema(TriggerUpdateInput, { io: 'input' }),
});

export const EMBEDDED_INPUT_VALIDATORS = Object.freeze({
  sources: z.object({}).strict(),
  create: TriggerCreateInput,
  list: TriggerListInput,
  inspect: TriggerInspectInput,
  pause: TriggerLifecycleInput,
  resume: TriggerLifecycleInput,
  delete: TriggerLifecycleInput,
  update: TriggerUpdateInput,
});
