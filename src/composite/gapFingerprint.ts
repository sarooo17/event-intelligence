import type { McpDeliveryGapState } from './deliveryGap.js';

// A signature of *scope-local committed delivery completeness*, not a
// substitute for a provider's authorization or replay attestation.
const MAX_SCOPE_MCP_STATES = 16_384;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort()
        .map(key => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function mcpGapSnapshot(states: McpDeliveryGapState[]): string {
  if (states.length > MAX_SCOPE_MCP_STATES) {
    throw new Error('MCP delivery state exceeds bounded gap snapshot capacity');
  }
  const elements=states.map(s=>JSON.stringify([
    s.connectionId,s.serverId,s.eventName,
    canonical(s.arguments ?? {}),
    s.gapUnresolved === true || s.truncated === true,
  ])).sort();
  // Exact deterministic encoding, no non-cryptographic hash collisions.
  return JSON.stringify(elements);
}
