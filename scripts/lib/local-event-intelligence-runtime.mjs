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
  PersistentEventStore,
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

export async function createLocalEventIntelligenceRuntime({
  env = process.env,
  mcpEventConnections = [],
  wakeHandlers = {},
  wake,
  semanticEvaluator,
} = {}) {
  const dataDir = env.DATA_DIR ?? './data';
  const store = new PersistentEventStore(dataDir);
  const restored = await store.init();

  const evaluator =
    semanticEvaluator !== undefined
      ? semanticEvaluator
      : env.TYPESAFE_API_KEY
        ? TypeSafeJevEvaluator.fromEnvironment(env)
        : null;

  const triggerEngine = new CompositeTriggerEngine(store, evaluator);

  const wakeCoordinators = new Map();

  const runtimeWakeTargets = readRuntimeWakeTargets(
    env.RUNTIME_WAKE_TARGETS_JSON,
  );
  for (const [runtime, target] of runtimeWakeTargets) {
    wakeCoordinators.set(
      runtime,
      new CompositeWakeCoordinator({
        store,
        triggerEngine,
        deliverer: createSignedRuntimeWakeDeliverer(target),
        packetBuilder: buildGenericRuntimeWakePacket,
      }),
    );
  }

  const hostWakeEntries =
    wakeHandlers instanceof Map
      ? [...wakeHandlers.entries()]
      : Object.entries(wakeHandlers || {});

  for (const [runtime, handler] of hostWakeEntries) {
    if (typeof handler !== 'function') {
      throw new Error(`Host wake handler for ${runtime} must be a function`);
    }
    wakeCoordinators.set(
      runtime,
      new CompositeWakeCoordinator({
        store,
        triggerEngine,
        packetBuilder: buildGenericRuntimeWakePacket,
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
  if (wake !== undefined) {
    if (typeof wake !== 'function') {
      throw new Error('Host wake dispatcher must be a function');
    }
    wakeCoordinator = new CompositeWakeCoordinator({
      store,
      triggerEngine,
      packetBuilder: buildGenericRuntimeWakePacket,
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

  const mcpEventsClient = new McpEventsClientManager({
    store,
    compositeEventConsumer,
    connections: mcpEventConnections,
    registerEventSource: (source) =>
      triggerControl.registerEventSource(
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
    store,
    evaluator,
    triggerEngine,
    triggerControl,
    triggerInspector,
    compositeEventConsumer,
    temporalScheduler,
    mcpEventsClient,
    discovery,
    async close() {
      temporalScheduler.stop();
      mcpEventsClient.stop();
    },
  };
}
