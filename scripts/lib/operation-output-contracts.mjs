import * as z from 'zod/v4';
import { OPERATION_MANIFEST } from './operation-manifest.mjs';

/**
 * Phase one of public tool output parity (#43): only operations with a
 * verifiable shared semantic core are modeled, and deliberate surface-specific
 * projections remain explicit rather than falsifying full wire equivalence.
 *
 * These are minimal shape contracts, not an assertion that nested evidence
 * or provider-produced records are safe/trusted.
 */
export const OPERATION_OUTPUT_CONTRACT_VERSION = '1';

const sourceList = z.object({
  sources: z.array(z.unknown()),
}).passthrough();

const stdioList = z.object({
  triggers: z.array(z.unknown()),
}).passthrough();

const embeddedList = stdioList.extend({
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
});

// Only the standalone MCP planner exposes this result. The embedded
// integration calls its scoped planner directly, not a model-facing
// trigger_plan operation. Keep the contract aligned to the canonical
// TriggerPlanner.plan result while preserving nested Pattern/evidence data.
const stdioPlan = z.object({
  planVersion: z.literal('2'),
  definition: z.record(z.string(), z.unknown()),
  connectionIds: z.array(z.string().min(1)),
  resolvedSources: z.array(z.unknown()),
  warnings: z.array(z.unknown()),
  explanation: z.object({
    when: z.record(z.string(), z.unknown()),
    then: z.record(z.string(), z.unknown()),
  }).passthrough(),
}).passthrough();

// Stdio-only read contracts. Do not claim matching model-facing tools exist
// in the embedded facade, and do not try to parse provider-owned event data.
const stdioLanguage = z.object({
  version: z.literal('3'),
  authoringSurface: z.literal('TriggerPlanInput'),
  planner: z.literal('trigger_plan'),
  preferredAuthoring: z.string().min(1),
  canonicalRepresentation: z.string().min(1),
}).passthrough();

const stdioDerivedContracts = z.object({
  contracts: z.array(z.unknown()),
}).passthrough();

const stdioRuntimeStatus = z.object({
  restored: z.unknown(),
  hostMcpEventConnections: z.array(z.unknown()),
  pendingTemporalDeadlines: z.number().int().nonnegative(),
  derivedEvents: z.number().int().nonnegative(),
  derivedContracts: z.number().int().nonnegative(),
  writeEnabled: z.boolean(),
}).passthrough();

export const OPERATION_OUTPUT_CONTRACTS = Object.freeze({
  sources: Object.freeze({
    stdio: sourceList,
    embedded: sourceList,
  }),
  list: Object.freeze({
    stdio: stdioList,
    embedded: embeddedList,
  }),
  plan: Object.freeze({
    stdio: stdioPlan,
  }),
  languageDescribe: Object.freeze({
    stdio: stdioLanguage,
  }),
  derivedContracts: Object.freeze({
    stdio: stdioDerivedContracts,
  }),
  runtimeStatus: Object.freeze({
    stdio: stdioRuntimeStatus,
  }),
});

export function outputValidator(surface, operation) {
  if (!['embedded', 'stdio'].includes(surface)) {
    throw new TypeError('Unknown EI output surface');
  }
  if (!Object.hasOwn(OPERATION_OUTPUT_CONTRACTS, operation)) {
    throw new Error('Unmodeled EI output operation: ' + operation);
  }
  if (!OPERATION_MANIFEST[operation]?.surfaces[surface]) {
    throw new Error('Operation not exposed on EI surface: ' + operation);
  }
  return OPERATION_OUTPUT_CONTRACTS[operation][surface];
}

export function validateOperationOutput(surface, operation, value) {
  const result = outputValidator(surface, operation).safeParse(value);
  if (!result.success) {
    const error = new Error(
      'EI ' + surface + ' ' + operation + ' response violates v' +
      OPERATION_OUTPUT_CONTRACT_VERSION + ' output contract',
    );
    error.code = 'EI_OUTPUT_CONTRACT_INVALID';
    throw error;
  }
  // Validation is intentionally nontransforming: do not strip extra fields,
  // evidence, context or store records from an already-authorized response.
  return value;
}

export function outputJsonSchema(surface, operation) {
  return z.toJSONSchema(outputValidator(surface, operation), {io:'output'});
}
