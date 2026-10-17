import type {
  CompositeTriggerDefinition, TriggerClause,
} from '../intelligenceProtocol/triggerSchemas.js';
import type { PatternNodeV2 } from '../intelligenceProtocol/patternV2Schemas.js';

export interface McpDeliveryGapState {
  connectionId: string;
  serverId: string;
  eventName: string;
  arguments?: Record<string, unknown>;
  truncated?: boolean;
  gapUnresolved?: boolean;
  gapDetectedAt?: string;
  completenessRevision?: number;
}

// All source identities in the same scope use identical canonical JSON
// semantics, regardless of the input object's key insertion order.
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

export function sameSourceArguments(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  return JSON.stringify(canonical(left ?? {})) ===
    JSON.stringify(canonical(right ?? {}));
}

export function negativeForbiddenSourceRefs(root: PatternNodeV2): Set<string> {
  const out = new Set<string>();
  const collectRefs = (rootNode: PatternNodeV2): void => {
    // The evaluator bounds the public AST at 4096 occurrences before
    // evaluating; here a schema-validated AST is visited without payloads.
    const pending: PatternNodeV2[] = [rootNode];
    while (pending.length) {
      const node = pending.pop()!;
      if ('ref' in node && typeof node.ref === 'string') out.add(node.ref);
      if ('afterRef' in node && typeof node.afterRef === 'string') {
        out.add(node.afterRef);
      }
      if ('child' in node && node.child) pending.push(node.child);
      if ('children' in node && Array.isArray(node.children)) {
        pending.push(...node.children);
      }
      if ('forbidden' in node && node.forbidden) pending.push(node.forbidden);
    }
  };
  const nodes: PatternNodeV2[] = [root];
  while (nodes.length) {
    const node = nodes.pop()!;
    if (node.kind === 'absence' || node.kind === 'notPresent') {
      out.add(node.ref);
    }
    if (node.kind === 'notNext' || node.kind === 'notFollowedBy') {
      collectRefs(node.forbidden);
    }
    if ('child' in node && node.child) nodes.push(node.child);
    if ('children' in node && Array.isArray(node.children)) {
      nodes.push(...node.children);
    }
    if ('forbidden' in node && node.forbidden) nodes.push(node.forbidden);
  }
  return out;
}

function clauseMatchesGap(
  clause: TriggerClause,
  gap: McpDeliveryGapState,
): boolean {
  return clause.event === gap.eventName &&
    (!clause.serverId || clause.serverId === gap.serverId) &&
    sameSourceArguments(clause.arguments, gap.arguments);
}

/** Only source gaps owned by the trigger's authorized host connections. */
export function incompleteNegativeRefs(
  definition: CompositeTriggerDefinition,
  states: McpDeliveryGapState[],
  connectionIds: string[],
): Set<string> {
  const negative = negativeForbiddenSourceRefs(definition.pattern.root);
  if (!negative.size) return new Set();
  const connections = new Set(connectionIds);
  const refs = new Set<string>();
  for (const clause of definition.clauses) {
    if (!negative.has(clause.id)) continue;
    if (states.some(state=>
      (state.gapUnresolved === true || state.truncated === true) &&
      (!connections.size || connections.has(state.connectionId)) &&
      clauseMatchesGap(clause,state)
    )) refs.add(clause.id);
  }
  return refs;
}
