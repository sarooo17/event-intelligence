import * as z from 'zod/v4';
import { TriggerPlanInputSchema } from '../../dist/src/intelligenceProtocol/index.js';
import { OPERATION_MANIFEST } from './operation-manifest.mjs';

/**
 * Canonical schema source for the standalone stdio *projection*.
 * The host-neutral embedded projection is intentionally different (#43).
 * These Zod definitions are passed unchanged to McpServer.registerTool().
 */
const plan = TriggerPlanInputSchema;
const lifecycle = z.object({
  triggerId: z.string().min(1),
  version: z.string().min(1),
  confirmationId: z.string().min(1),
});

export const MCP_OPERATION_SCHEMAS = Object.freeze({
  sources: z.object({
    connectionIds: z.array(z.string()).optional(),
  }),
  languageDescribe: z.object({
    category: z.enum([
      'predicates', 'composition', 'temporal', 'pattern', 'windows',
      'aggregates', 'state', 'selection', 'semantic', 'execution',
      'correlation', 'timing', 'lifecycle',
    ]).optional(),
    operator: z.string().min(1).optional(),
  }).strict(),
  plan,
  list: z.object({}).strict(),
  inspect: z.object({
    triggerId: z.string().min(1),
    version: z.string().min(1).optional(),
    matchId: z.string().min(1).optional(),
  }),
  simulate: z.object({
    definition: z.record(z.string(), z.unknown()),
    events: z.array(z.record(z.string(), z.unknown())),
    until: z.string().optional(),
    order: z.enum(['provided', 'event_time']).default('provided'),
  }),
  derivedContracts: z.object({
    eventName: z.string().min(1).optional(),
  }),
  wakeHydrate: z.object({
    wakeId: z.string().min(1),
  }),
  runtimeStatus: z.object({}),
  create: z.object({
    definition: z.record(z.string(), z.unknown()).optional(),
    plan: plan.optional(),
    connectionIds: z.array(z.string()).min(1).optional(),
    confirmationId: z.string().min(1),
  }),
  pause: lifecycle,
  resume: lifecycle,
  delete: lifecycle,
  update: z.object({
    triggerId: z.string().min(1),
    expectedVersion: z.string().min(1),
    definition: z.record(z.string(), z.unknown()),
    connectionIds: z.array(z.string()).optional(),
    confirmationId: z.string().min(1),
  }),
});

const keys = Object.keys(OPERATION_MANIFEST).sort();
if (JSON.stringify(keys) !== JSON.stringify(Object.keys(MCP_OPERATION_SCHEMAS).sort())) {
  throw new Error('MCP schema registry must cover every canonical EI operation');
}

/** Return the same validator used by the actual MCP tool registration. */
export function mcpInputSchemaFor(operation) {
  if (!Object.hasOwn(MCP_OPERATION_SCHEMAS, operation)) {
    throw new Error('Unknown EI MCP operation: ' + operation);
  }
  return MCP_OPERATION_SCHEMAS[operation];
}
