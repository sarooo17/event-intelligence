import {
  createLocalEventIntelligenceRuntime,
} from './lib/local-event-intelligence-runtime.mjs';
import {
  createHostMcpEventsConnection,
} from './lib/mcp-events-client.mjs';
import {
  DEFAULT_EVENT_SCOPE_ID,
  PersistentEventStore,
  normalizeEventScopeId,
} from './lib/persistent-event-store.mjs';

function normalizeMcpConnection(input) {
  const connectionId = String(
    input?.connectionId ?? input?.id ?? input?.name ?? '',
  ).trim();
  if (!connectionId) {
    throw new Error('Host MCP registry entry requires connectionId/id/name');
  }

  return createHostMcpEventsConnection({
    ...input,
    connectionId,
    serverId: input?.serverId ?? connectionId,
    client: input?.client ?? (
      input && typeof input.request === 'function' ? input : undefined
    ),
  });
}

async function listRegistryConnections(registry) {
  if (!registry) return [];

  if (typeof registry.listConnections === 'function') {
    return Array.from(await registry.listConnections());
  }
  if (typeof registry.list === 'function') {
    return Array.from(await registry.list());
  }
  if (typeof registry.connections === 'function') {
    return Array.from(await registry.connections());
  }
  if (Array.isArray(registry)) return registry;
  if (typeof registry[Symbol.iterator] === 'function') {
    return Array.from(registry);
  }

  throw new Error(
    'mcpRegistry must expose listConnections(), list(), connections(), or be iterable',
  );
}

export function createMcpRegistryAdapter({
  listConnections,
  subscribe,
} = {}) {
  if (typeof listConnections !== 'function') {
    throw new Error('MCP registry adapter requires listConnections()');
  }
  if (subscribe !== undefined && typeof subscribe !== 'function') {
    throw new Error('MCP registry adapter subscribe must be a function');
  }
  return {
    listConnections,
    ...(subscribe ? { subscribe } : {}),
  };
}

function scopedHostView(runtime, context) {
  const scopeId = context.scopeId;
  return {
    scopeId,
    runtime: context,
    store: context.store,
    triggerControl: context.triggerControl,
    triggerInspector: context.triggerInspector,
    triggerPlanner: context.triggerPlanner,
    activationHydrator: context.activationHydrator,
    planTrigger(input) {
      return context.triggerPlanner.plan(input);
    },
    hydrateWake(wakeId) {
      return context.activationHydrator.hydrateWake(wakeId);
    },
    get eventSources() {
      return context.triggerControl.listEventSources();
    },
    async attachMcpClient(connection) {
      const normalized = normalizeMcpConnection({
        ...connection,
        scopeId,
      });
      return runtime.mcpEventsClient.attachConnection(normalized);
    },
    mcpStatus() {
      return runtime.mcpEventsClient.status()
        .filter((entry) => entry.scopeId === scopeId);
    },
  };
}

/**
 * Embed Event Intelligence once at the harness/host level.
 *
 * The host keeps ownership of MCP transports, auth, tools and credentials.
 * Event Intelligence discovers Events-capable clients from the host registry,
 * ignores tools-only MCPs, and stores only event/cursor state.
 */
export async function createEventIntelligenceHost({
  dataDir,
  store,
  env = {},
  mcpRegistry,
  mcpClients = [],
  wake,
  wakeHandlers = {},
  semanticEvaluator,
} = {}) {
  const explicitConnections = mcpClients.map(normalizeMcpConnection);
  const runtime = await createLocalEventIntelligenceRuntime({
    env: {
      ...process.env,
      ...env,
      ...(dataDir ? { DATA_DIR: dataDir } : {}),
    },
    mcpEventConnections: explicitConnections,
    wake,
    wakeHandlers,
    semanticEvaluator,
    store,
  });

  const registryManaged = new Set();
  let unsubscribe = null;

  const refreshMcpRegistry = async () => {
    const entries = await listRegistryConnections(mcpRegistry);
    const desired = new Map();

    for (const entry of entries) {
      const normalized = normalizeMcpConnection(entry);
      desired.set(normalized.connectionId, normalized);
    }

    const outcomes = [];

    for (const connectionId of [...registryManaged]) {
      if (!desired.has(connectionId)) {
        await runtime.mcpEventsClient.detachConnection(connectionId);
        registryManaged.delete(connectionId);
        outcomes.push({ connectionId, status: 'detached' });
      }
    }

    for (const [connectionId, connection] of desired) {
      const existing = runtime.mcpEventsClient.connections.get(connectionId);
      if (existing) {
        if (
          existing.identity === connection.identity &&
          existing.serverId === connection.serverId &&
          existing.scopeId === connection.scopeId
        ) {
          registryManaged.add(connectionId);
          outcomes.push({ connectionId, status: 'already_attached' });
          continue;
        }

        await runtime.mcpEventsClient.detachConnection(connectionId);
        registryManaged.delete(connectionId);
      }

      try {
        const result = await runtime.mcpEventsClient.attachConnection(connection);
        registryManaged.add(connectionId);
        outcomes.push({
          connectionId,
          status: existing ? 'reattached' : 'attached',
          events: result.events.map((event) => event.name),
        });
      } catch (error) {
        await runtime.mcpEventsClient.detachConnection(connectionId);
        if (
          error &&
          typeof error === 'object' &&
          error.code === 'MCP_EVENTS_CAPABILITY_UNAVAILABLE'
        ) {
          outcomes.push({
            connectionId,
            status: 'ignored_no_events',
          });
          continue;
        }
        outcomes.push({
          connectionId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return outcomes;
  };

  if (mcpRegistry) {
    await refreshMcpRegistry();

    if (typeof mcpRegistry.subscribe === 'function') {
      const maybeUnsubscribe = mcpRegistry.subscribe(() => {
        refreshMcpRegistry().catch((error) => {
          console.error(JSON.stringify({
            message: 'event_intelligence_mcp_registry_refresh_failed',
            error: error instanceof Error ? error.message : String(error),
          }));
        });
      });
      if (typeof maybeUnsubscribe === 'function') {
        unsubscribe = maybeUnsubscribe;
      }
    }
  }

  return {
    scopeId: DEFAULT_EVENT_SCOPE_ID,
    runtime,
    get store() {
      return runtime.store;
    },
    get triggerControl() {
      return runtime.triggerControl;
    },
    get triggerInspector() {
      return runtime.triggerInspector;
    },
    get triggerPlanner() {
      return runtime.triggerPlanner;
    },
    get activationHydrator() {
      return runtime.activationHydrator;
    },
    planTrigger(input) {
      return runtime.triggerPlanner.plan(input);
    },
    hydrateWake(wakeId) {
      return runtime.activationHydrator.hydrateWake(wakeId);
    },
    get eventSources() {
      return runtime.triggerControl.listEventSources();
    },
    refreshMcpRegistry,
    async attachMcpClient(connection) {
      const normalized = normalizeMcpConnection(connection);
      return runtime.mcpEventsClient.attachConnection(normalized);
    },
    async detachMcpClient(connectionId) {
      registryManaged.delete(connectionId);
      return runtime.mcpEventsClient.detachConnection(connectionId);
    },
    mcpStatus() {
      return runtime.mcpEventsClient.status();
    },
    loadedScopes() {
      return runtime.loadedScopes();
    },
    async scope(scopeIdInput = DEFAULT_EVENT_SCOPE_ID) {
      const scopeId = normalizeEventScopeId(scopeIdInput);
      const context = await runtime.scope(scopeId);
      return scopedHostView(runtime, context);
    },
    async close() {
      unsubscribe?.();
      await runtime.close();
    },
  };
}

export {
  createHostMcpEventsConnection,
  PersistentEventStore,
};
