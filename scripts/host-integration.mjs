import {
  describeTriggerLanguage,
} from '../dist/src/intelligenceProtocol/index.js';
import {
  createLocalEventIntelligenceRuntime,
} from './lib/local-event-intelligence-runtime.mjs';
import {
  createHostMcpEventsConnection,
  isUnavailableCapability,
} from './lib/mcp-events-client.mjs';
import {
  DEFAULT_EVENT_SCOPE_ID,
  PersistentEventStore,
  normalizeEventScopeId,
} from './lib/persistent-event-store.mjs';
import {
  assertSharedStoreCapabilities,
  describeStoreCapabilities,
  validateSharedStoreCapabilities,
} from './lib/store-capabilities.mjs';

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

function scopedHostView(runtime, context, assertHostOpen) {
  const scopeId = context.scopeId;
  return {
    scopeId,
    runtime: context,
    store: context.store,
    storeCapabilities: describeStoreCapabilities(context.store),
    triggerControl: context.triggerControl,
    triggerInspector: context.triggerInspector,
    triggerPlanner: context.triggerPlanner,
    activationHydrator: context.activationHydrator,
    planTrigger(input) {
      return context.triggerPlanner.plan(input);
    },
    describeTriggerLanguage(input = {}) {
      return describeTriggerLanguage(input);
    },
    hydrateWake(wakeId) {
      return context.activationHydrator.hydrateWake(wakeId);
    },
    get eventSources() {
      return context.triggerControl.listEventSources();
    },
    async attachMcpClient(connection) {
      assertHostOpen();
      const normalized = normalizeMcpConnection({
        ...connection,
        scopeId,
      });
      return runtime.mcpEventsClient.attachConnection(normalized);
    },
    async mcpStatus() {
      return (await runtime.mcpEventsClient.status())
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
  observability,
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
    observability,
  });
  const observer = runtime.observability;

  const registryManaged = new Set();
  let unsubscribe = null;
  let registryRefreshPromise = null;
  let registryRefreshRequested = false;
  let closing = false;
  let closePromise = null;

  function assertHostOpen() {
    if (closing) {
      const error = new Error('Event Intelligence host is closing');
      error.code = 'EI_HOST_CLOSED';
      throw error;
    }
  }

  // detachConnection revokes the old connection synchronously, but its
  // durable cleanup may reject after a host has attached a replacement.
  // Release registry ownership whenever the original object is no longer
  // attached, even on cleanup failure. Never label a replacement as ours.
  const detachRegistryConnection = async (connectionId) => {
    const original = runtime.mcpEventsClient.connections.get(connectionId);
    try {
      await runtime.mcpEventsClient.detachConnection(connectionId);
      return null;
    } catch {
      return {
        connectionId,
        status: 'error',
        code: 'EI_HOST_REGISTRY_DETACH_FAILED',
        error: 'Registry connection detach cleanup failed',
      };
    } finally {
      if (!original ||
          runtime.mcpEventsClient.connections.get(connectionId) !== original) {
        registryManaged.delete(connectionId);
      }
    }
  };

  const refreshMcpRegistryOnce = async () => {
    if (closing) return [];
    const entries = await listRegistryConnections(mcpRegistry);
    // listConnections() can resolve after shutdown starts. Never adopt
    // connections reported by an obsolete callback after host close.
    if (closing) return [];
    const desired = new Map();

    for (const entry of entries) {
      const normalized = normalizeMcpConnection(entry);
      desired.set(normalized.connectionId, normalized);
    }

    const outcomes = [];

    for (const connectionId of [...registryManaged]) {
      if (closing) break;
      if (!desired.has(connectionId)) {
        const failure = await detachRegistryConnection(connectionId);
        outcomes.push(failure ?? { connectionId, status: 'detached' });
      }
    }

    for (const [connectionId, connection] of desired) {
      if (closing) break;
      const existing = runtime.mcpEventsClient.connections.get(connectionId);
      // The host owns explicit and manually attached MCP connections.
      // Only connections *previously attached by this registry* may be
      // refreshed or removed by registry reconciliation. Identity equality
      // alone does not transfer lifecycle ownership to the registry.
      if (existing && !registryManaged.has(connectionId)) {
        outcomes.push({
          connectionId,
          status: 'error',
          code: 'EI_HOST_REGISTRY_ID_CONFLICT',
          error: 'Registry connection ID conflicts with a host-owned MCP connection',
        });
        continue;
      }
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

        const failure = await detachRegistryConnection(connectionId);
        if (failure) {
          outcomes.push(failure);
          continue;
        }
        // Detach performs asynchronous durable cleanup. A host may manually
        // attach a connection with the same ID while it is suspended. Never
        // replace that new host-owned connection when reconciliation resumes.
        if (runtime.mcpEventsClient.connections.has(connectionId)) {
          outcomes.push({
            connectionId,
            status: 'error',
            code: 'EI_HOST_REGISTRY_ID_CONFLICT',
            error: 'Registry connection ID conflicts with a host-owned MCP connection',
          });
          continue;
        }
      }

      let attemptedConnection = null;
      try {
        // attachConnection adds the normalized connection before its first
        // asynchronous discovery await. Remember the actual object identity:
        // later host replacement must not be detached by catch cleanup.
        if (closing) break;
        const attachment = runtime.mcpEventsClient.attachConnection(connection);
        attemptedConnection = runtime.mcpEventsClient.connections.get(connectionId);
        const result = await attachment;
        if (runtime.mcpEventsClient.connections.get(connectionId) !== attemptedConnection ||
            !attemptedConnection) {
          outcomes.push({
            connectionId,
            status: 'error',
            code: 'EI_HOST_REGISTRY_ID_CONFLICT',
            error: 'Registry connection was replaced during event discovery',
          });
          continue;
        }
        registryManaged.add(connectionId);
        outcomes.push({
          connectionId,
          status: existing ? 'reattached' : 'attached',
          events: result.events.map((event) => event.name),
        });
      } catch (error) {
        // Cleanup only a connection that this attach attempt actually
        // installed; never revoke a replacement installed by the host.
        if (attemptedConnection &&
            runtime.mcpEventsClient.connections.get(connectionId) === attemptedConnection) {
          await runtime.mcpEventsClient.detachConnection(connectionId);
        }
        if (isUnavailableCapability(error)) {
          outcomes.push({
            connectionId,
            status: 'ignored_no_events',
          });
          continue;
        }
        // Provider-side errors can contain credentials or untrusted event
        // payloads. Registry outcomes also reach host diagnostics/telemetry.
        outcomes.push({
          connectionId,
          status: 'error',
          code: 'EI_HOST_REGISTRY_ATTACH_FAILED',
          error: 'MCP registry connection attach failed',
        });
      }
    }

    await Promise.all(outcomes.map((outcome) => observer.emit({
      event: 'ei.source.registry_update',
      level:
        outcome.status === 'error'
          ? 'error'
          : outcome.status === 'ignored_no_events' ||
              outcome.status === 'already_attached'
            ? 'debug'
            : 'info',
      connectionId: outcome.connectionId,
      status: outcome.status,
      ...(outcome.error ? { error: new Error(outcome.error) } : {}),
      ...(outcome.events ? { metadata: { eventNames: outcome.events } } : {}),
    })));

    return outcomes;
  };

  const refreshMcpRegistry = () => {
    try { assertHostOpen(); } catch (error) {
      return Promise.reject(error);
    }
    if (registryRefreshPromise) {
      registryRefreshRequested = true;
      return registryRefreshPromise;
    }

    registryRefreshPromise = (async () => {
      const outcomes = [];
      do {
        registryRefreshRequested = false;
        outcomes.push(...await refreshMcpRegistryOnce());
      } while (registryRefreshRequested && !closing);
      return outcomes;
    })().finally(() => {
      registryRefreshPromise = null;
    });

    return registryRefreshPromise;
  };

  if (mcpRegistry) {
    try {
      await refreshMcpRegistry();
      if (typeof mcpRegistry.subscribe === 'function') {
        const maybeUnsubscribe = mcpRegistry.subscribe(() => {
          if (closing) return;
          refreshMcpRegistry().catch(() => {
            if (closing) return;
            void observer.emit({
              event: 'ei.source.refresh_failed',
              level: 'error',
              error: new Error('MCP registry refresh failed'),
            });
          });
        });
        if (typeof maybeUnsubscribe === 'function') {
          unsubscribe = maybeUnsubscribe;
        }
      }
    } catch (error) {
      // The local engine and durable subscriptions have already started.
      // Failed registry initialization must not strand timers/connections.
      closing = true;
      try { unsubscribe?.(); } catch {}
      try { await registryRefreshPromise; } catch {}
      try { await runtime.close(); } catch {}
      throw error;
    }
  }

  return {
    scopeId: DEFAULT_EVENT_SCOPE_ID,
    runtime,
    get store() {
      return runtime.store;
    },
    get storeCapabilities() {
      return runtime.storeCapabilities;
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
    describeTriggerLanguage(input = {}) {
      return describeTriggerLanguage(input);
    },
    hydrateWake(wakeId) {
      return runtime.activationHydrator.hydrateWake(wakeId);
    },
    get eventSources() {
      return runtime.triggerControl.listEventSources();
    },
    refreshMcpRegistry,
    async attachMcpClient(connection) {
      assertHostOpen();
      const normalized = normalizeMcpConnection(connection);
      return runtime.mcpEventsClient.attachConnection(normalized);
    },
    async detachMcpClient(connectionId) {
      registryManaged.delete(connectionId);
      return runtime.mcpEventsClient.detachConnection(connectionId);
    },
    async mcpStatus() {
      return await runtime.mcpEventsClient.status();
    },
    loadedScopes() {
      return runtime.loadedScopes();
    },
    async scope(scopeIdInput = DEFAULT_EVENT_SCOPE_ID) {
      assertHostOpen();
      const scopeId = normalizeEventScopeId(scopeIdInput);
      const context = await runtime.scope(scopeId);
      assertHostOpen();
      return scopedHostView(runtime, context, assertHostOpen);
    },
    close() {
      if (closePromise) return closePromise;
      // Publish a shared promise BEFORE invoking any user-owned provider
      // hook. A session close callback may synchronously re-enter host.close().
      let resolveClose;
      let rejectClose;
      closePromise = new Promise((resolve, reject) => {
        resolveClose = resolve;
        rejectClose = reject;
      });
      closing = true;
      let managerShutdown;
      try {
        // Fence the publicly exposed manager now, in the same JS turn,
        // before even the first async registry/observability boundary.
        managerShutdown = runtime.mcpEventsClient.close();
        void managerShutdown.catch(() => {});
      } catch (error) {
        rejectClose(error);
        return closePromise;
      }
      Promise.resolve().then(async () => {
        let unsubscribeError;
        try { unsubscribe?.(); } catch (error) {
          unsubscribeError = error;
        }
        try { await registryRefreshPromise; } catch {}
        await managerShutdown;
        await runtime.close();
        if (unsubscribeError) throw unsubscribeError;
      }).then(resolveClose, rejectClose);
      return closePromise;
    },
  };
}

export {
  assertSharedStoreCapabilities,
  createHostMcpEventsConnection,
  describeStoreCapabilities,
  PersistentEventStore,
  validateSharedStoreCapabilities,
};