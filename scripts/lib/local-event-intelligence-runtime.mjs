import {
  TypeSafeJevEvaluator,
} from '../../dist/src/semantic/typesafeJevEvaluator.js';
import {
  CompositeTriggerEngine,
} from '../../dist/src/composite/engine.js';
import {
  CompositeWakeCoordinator,
} from './composite-wake-coordinator.mjs';
import {
  buildGenericRuntimeWakePacket,
  createSignedRuntimeWakeDeliverer,
  readRuntimeWakeTargets,
} from './generic-runtime-wake.mjs';
import {
  CompositeEventConsumer,
} from './composite-event-consumer.mjs';
import {
  DerivedEventCoordinator,
} from './derived-event-coordinator.mjs';
import {
  TriggerControlPlane,
} from './trigger-control-plane.mjs';
import {
  DEFAULT_EVENT_SCOPE_ID,
  PersistentEventStore,
  normalizeEventScopeId,
} from './persistent-event-store.mjs';
import {
  TriggerInspector,
} from './trigger-inspector.mjs';
import {
  TemporalDeadlineScheduler,
} from './temporal-deadline-scheduler.mjs';
import {
  McpEventsClientManager,
} from './mcp-events-client.mjs';

const REQUIRED_STORE_METHODS = [
  'putTrigger',
  'listTriggers',
  'getTriggerState',
  'setTriggerState',
  'appendTriggerMatch',
  'listTriggerMatches',
  'putEventSource',
  'listEventSources',
  'appendWake',
  'latestWake',
  'appendAudit',
  'auditLength',
  'getMcpClientState',
  'putMcpClientState',
  'appendMcpOccurrence',
];

function assertStoreContract(store) {
  if (!store || typeof store !== 'object') {
    throw new Error('Event Intelligence store must be an object');
  }
  const missing = REQUIRED_STORE_METHODS.filter(
    (method) => typeof store[method] !== 'function',
  );
  if (missing.length) {
    const error = new Error(
      `Event Intelligence store is missing required methods: ${missing.join(', ')}`,
    );
    error.code = 'EVENT_INTELLIGENCE_STORE_INVALID';
    throw error;
  }
  return store;
}

async function initializeStore(store) {
  const restored =
    typeof store.init === 'function'
      ? await store.init()
      : {};
  assertStoreContract(store);
  return restored;
}

function scopedPacketBuilder(scopeId) {
  return (input) => ({
    ...buildGenericRuntimeWakePacket(input),
    scope_id: scopeId,
  });
}

export async function createLocalEventIntelligenceRuntime({
  env = process.env,
  mcpEventConnections = [],
  wakeHandlers = {},
  wake,
  semanticEvaluator,
  store: providedStore,
} = {}) {
  const dataDir = env.DATA_DIR ?? './data';
  const rootStore = providedStore ?? new PersistentEventStore(dataDir);
  const restored = await initializeStore(rootStore);

  const evaluator =
    semanticEvaluator !== undefined
      ? semanticEvaluator
      : env.TYPESAFE_API_KEY
        ? TypeSafeJevEvaluator.fromEnvironment(env)
        : null;

  const runtimeWakeTargets = readRuntimeWakeTargets(
    env.RUNTIME_WAKE_TARGETS_JSON,
  );
  const hostWakeEntries =
    wakeHandlers instanceof Map
      ? [...wakeHandlers.entries()]
      : Object.entries(wakeHandlers || {});

  if (wake !== undefined && typeof wake !== 'function') {
    throw new Error('Host wake dispatcher must be a function');
  }
  for (const [runtime, handler] of hostWakeEntries) {
    if (typeof handler !== 'function') {
      throw new Error(`Host wake handler for ${runtime} must be a function`);
    }
  }

  const scopeContexts = new Map();

  const createScopeContext = async (scopeIdInput = DEFAULT_EVENT_SCOPE_ID) => {
    const scopeId = normalizeEventScopeId(scopeIdInput);
    const cached = scopeContexts.get(scopeId);
    if (cached) return cached;

    let store;
    if (scopeId === DEFAULT_EVENT_SCOPE_ID) {
      store = rootStore;
    } else {
      if (typeof rootStore.forScope !== 'function') {
        const error = new Error(
          `Configured Event Intelligence store does not support scope ${scopeId}`,
        );
        error.code = 'EVENT_INTELLIGENCE_STORE_SCOPE_UNSUPPORTED';
        throw error;
      }
      store = await rootStore.forScope(scopeId);
      assertStoreContract(store);
    }

    const triggerEngine = new CompositeTriggerEngine(store, evaluator);
    const wakeCoordinators = new Map();
    const packetBuilder = scopedPacketBuilder(scopeId);

    for (const [runtime, target] of runtimeWakeTargets) {
      wakeCoordinators.set(
        runtime,
        new CompositeWakeCoordinator({
          store,
          triggerEngine,
          deliverer: createSignedRuntimeWakeDeliverer(target),
          packetBuilder,
        }),
      );
    }

    for (const [runtime, handler] of hostWakeEntries) {
      wakeCoordinators.set(
        runtime,
        new CompositeWakeCoordinator({
          store,
          triggerEngine,
          packetBuilder,
          deliverer: async (packet) => {
            const result = await handler(packet);
            if (typeof result === 'string' && result) {
              return { runtimeReceiptId: result };
            }
            if (
              result &&
              typeof result === 'object' &&
              typeof result.runtimeReceiptId === 'string' &&
              result.runtimeReceiptId
            ) {
              return result;
            }
            throw new Error(
              `Host wake handler for ${runtime} must return runtimeReceiptId`,
            );
          },
        }),
      );
    }

    let wakeCoordinator = null;
    if (wake) {
      wakeCoordinator = new CompositeWakeCoordinator({
        store,
        triggerEngine,
        packetBuilder,
        deliverer: async (packet) => {
          const result = await wake(packet);
          if (typeof result === 'string' && result) {
            return { runtimeReceiptId: result };
          }
          if (
            result &&
            typeof result === 'object' &&
            typeof result.runtimeReceiptId === 'string' &&
            result.runtimeReceiptId
          ) {
            return result;
          }
          throw new Error('Host wake dispatcher must return runtimeReceiptId');
        },
      });
    }

    const derivedEventCoordinator = new DerivedEventCoordinator({ store });
    const compositeEventConsumer = new CompositeEventConsumer({
      store,
      triggerEngine,
      wakeCoordinator,
      wakeCoordinators,
      derivedEventCoordinator,
      maxDerivedDepth: Number(env.MAX_DERIVED_EVENT_DEPTH ?? 16),
    });

    const temporalScheduler = new TemporalDeadlineScheduler({
      store,
      compositeEventConsumer,
      intervalMs: Number(env.TEMPORAL_TICK_MS ?? 1000),
    });
    temporalScheduler.start();

    const triggerControl = new TriggerControlPlane({
      store,
      triggerEngine,
    });
    const triggerInspector = new TriggerInspector({ store });

    const context = {
      scopeId,
      store,
      evaluator,
      triggerEngine,
      triggerControl,
      triggerInspector,
      compositeEventConsumer,
      temporalScheduler,
      wakeCoordinator,
      wakeCoordinators,
      close() {
        temporalScheduler.stop();
      },
    };
    scopeContexts.set(scopeId, context);
    return context;
  };

  const defaultContext = await createScopeContext(DEFAULT_EVENT_SCOPE_ID);

  if (typeof rootStore.listScopeIds === 'function') {
    const restoredScopes = await rootStore.listScopeIds();
    for (const scopeId of restoredScopes) {
      if (scopeId !== DEFAULT_EVENT_SCOPE_ID) {
        await createScopeContext(scopeId);
      }
    }
  }

  const mcpEventsClient = new McpEventsClientManager({
    store: defaultContext.store,
    compositeEventConsumer: defaultContext.compositeEventConsumer,
    resolveScope: createScopeContext,
    connections: mcpEventConnections,
    registerEventSource: (source) =>
      defaultContext.triggerControl.registerEventSource(
        source,
        {
          type: 'system',
          principal_id: 'event-intelligence:host-mcp-client',
        },
      ),
  });

  const discovery = await mcpEventsClient.discoverAll();
  mcpEventsClient.start();

  return {
    restored,
    store: defaultContext.store,
    evaluator,
    triggerEngine: defaultContext.triggerEngine,
    triggerControl: defaultContext.triggerControl,
    triggerInspector: defaultContext.triggerInspector,
    compositeEventConsumer: defaultContext.compositeEventConsumer,
    temporalScheduler: defaultContext.temporalScheduler,
    mcpEventsClient,
    discovery,
    scope: createScopeContext,
    loadedScopes() {
      return [...scopeContexts.keys()].sort();
    },
    async close() {
      mcpEventsClient.stop();
      for (const context of scopeContexts.values()) {
        context.close();
      }
    },
  };
}
