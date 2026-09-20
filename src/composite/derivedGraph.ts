import type {
  CompositeTriggerDefinition,
} from '../intelligenceProtocol/triggerSchemas.js';

const DERIVED_SERVER_ID = 'event-intelligence:derived';

function eventNode(eventName: string, serverId?: string): string {
  return `${serverId || DERIVED_SERVER_ID}::${eventName}`;
}

export function assertNoDerivedEventCycle(
  existing: CompositeTriggerDefinition[],
  candidate: CompositeTriggerDefinition,
  getState?: (
    triggerId: string,
    version: string,
  ) => { status: string } | null,
): void {
  const definitions = [
    ...existing.filter((definition) => {
      const state = getState?.(definition.triggerId, definition.version);
      return !state || state.status === 'active' || state.status === 'paused';
    }),
    candidate,
  ].filter((definition) => definition.derivedEvent);

  const graph = new Map<string, Set<string>>();
  for (const definition of definitions) {
    const output = eventNode(
      definition.derivedEvent!.name,
      DERIVED_SERVER_ID,
    );
    for (const clause of definition.clauses) {
      const input = eventNode(clause.event, clause.serverId);
      const edges = graph.get(input) ?? new Set<string>();
      edges.add(output);
      graph.set(input, edges);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const dfs = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) {
      if (dfs(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  for (const node of graph.keys()) {
    if (dfs(node)) {
      const error = new Error(
        `Derived event graph contains a cycle involving ${node}`,
      ) as Error & { code?: string };
      error.code = 'TRIGGER_DERIVED_EVENT_CYCLE';
      throw error;
    }
  }
}
