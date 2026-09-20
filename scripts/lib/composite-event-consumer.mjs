import {
  mcpOccurrenceToCorrelatableEvent,
} from '../../dist/src/mcpEvents/consumer.js';

export class CompositeEventConsumer {
  constructor({
    store,
    triggerEngine,
    wakeCoordinator = null,
    wakeCoordinators = null,
    derivedEventCoordinator = null,
    processor = null,
    maxDerivedDepth = 16,
  }) {
    this.store = store;
    this.triggerEngine = triggerEngine;
    this.wakeCoordinator = wakeCoordinator;
    this.wakeCoordinators = wakeCoordinators instanceof Map
      ? wakeCoordinators
      : new Map();
    this.derivedEventCoordinator = derivedEventCoordinator;
    this.processor = processor;
    this.maxDerivedDepth = Math.max(1, Number(maxDerivedDepth) || 16);
  }

  coordinatorFor(runtime) {
    const configured = this.wakeCoordinators.get(runtime);
    if (configured) return configured;
    return this.wakeCoordinator;
  }

  async ingestMcpOccurrence({
    event,
    serverId,
    provider,
    traceId,
  }) {
    const correlatable = await mcpOccurrenceToCorrelatableEvent(
      event,
      {
        traceId,
        ...(provider ? { provider } : {}),
        ...(serverId ? { serverId } : {}),
      },
    );

    return this.ingestCorrelatable(correlatable);
  }

  async ingestCorrelatable(event, context = {}) {
    const derivedDepth = Number(context.derivedDepth ?? 0);
    const results = await this.triggerEngine.ingest(event);
    const deliveries = [];
    const derivedEvents = [];

    for (const result of results) {
      if (!result.matched || !result.match) continue;

      const definition = this.store.listTriggers().find(
        (candidate) =>
          candidate.triggerId === result.match.triggerId &&
          candidate.version === result.match.triggerVersion,
      );

      if (!definition) {
        deliveries.push({
          triggerId: result.triggerId,
          matchId: result.match.matchId,
          wakeId: null,
          status: 'trigger_definition_missing',
          runtimeReceiptId: null,
        });
        continue;
      }

      if (definition.derivedEvent && this.derivedEventCoordinator) {
        if (derivedDepth >= this.maxDerivedDepth) {
          const error = new Error(
            `Derived event chain exceeded max depth ${this.maxDerivedDepth}`,
          );
          error.code = 'DERIVED_EVENT_CHAIN_DEPTH_EXCEEDED';
          throw error;
        }

        const emission = await this.derivedEventCoordinator.emitMatched(
          result.match,
          definition,
        );
        const derivedRecord = emission.record;
        const summary = {
          triggerId: result.triggerId,
          matchId: result.match.matchId,
          status: emission.status,
          accepted: emission.accepted,
          eventId: derivedRecord?.event.sourceEventId ?? null,
          eventName: derivedRecord?.event.name ?? definition.derivedEvent.name,
          nested: null,
        };

        if (derivedRecord) {
          // Re-enter even on replay. Downstream match/event idempotency makes this
          // restart-safe if the process crashed after persistence but before fan-out.
          summary.nested = await this.ingestCorrelatable(
            derivedRecord.event,
            { derivedDepth: derivedDepth + 1 },
          );

          if (!definition.target) {
            await this.triggerEngine.markDerivedEmitted(
              result.match.matchId,
              derivedRecord.event.sourceEventId,
            );
          }
        }

        derivedEvents.push(summary);
      }

      if (!definition.target) {
        continue;
      }

      const coordinator = this.coordinatorFor(definition.target.runtime);
      if (!coordinator) {
        deliveries.push({
          triggerId: result.triggerId,
          matchId: result.match.matchId,
          wakeId: null,
          status: 'runtime_unconfigured',
          runtimeReceiptId: null,
        });
        continue;
      }

      const delivery = await coordinator.deliverMatched(result.match);
      const persistedWake = delivery.wake;

      if (
        persistedWake?.status === 'delivered' &&
        persistedWake.runtimeReceiptId &&
        this.processor
      ) {
        const handled = await this.processor.acknowledgeWake(
          persistedWake.wakeId,
          persistedWake.runtimeReceiptId,
        );
        deliveries.push({
          triggerId: result.triggerId,
          matchId: result.match.matchId,
          wakeId: handled.wakeId,
          status: handled.status,
          runtimeReceiptId: handled.runtimeReceiptId ?? null,
        });
      } else {
        deliveries.push({
          triggerId: result.triggerId,
          matchId: result.match.matchId,
          wakeId: persistedWake?.wakeId ?? null,
          status: delivery.status,
          runtimeReceiptId: persistedWake?.runtimeReceiptId ?? null,
        });
      }
    }

    return {
      event,
      results,
      deliveries,
      derivedEvents,
    };
  }
}
