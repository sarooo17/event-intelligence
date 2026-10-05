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
    maxDerivedDepth = 16,
    observability = null,
  }) {
    this.store = store;
    this.triggerEngine = triggerEngine;
    this.wakeCoordinator = wakeCoordinator;
    this.wakeCoordinators = wakeCoordinators instanceof Map
      ? wakeCoordinators
      : new Map();
    this.derivedEventCoordinator = derivedEventCoordinator;
    this.maxDerivedDepth = Math.max(1, Number(maxDerivedDepth) || 16);
    this.observability = observability;
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
    subscriptionArguments,
    receivedAt,
  }) {
    const correlatable = await mcpOccurrenceToCorrelatableEvent(
      event,
      {
        traceId,
        ...(provider ? { provider } : {}),
        ...(serverId ? { serverId } : {}),
        subscriptionArguments: subscriptionArguments ?? {},
        ...(receivedAt ? { receivedAt } : {}),
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

      await this.observability?.emit({
        event: 'ei.match.matched',
        level: 'info',
        traceId: event.traceId,
        triggerId: result.match.triggerId,
        matchId: result.match.matchId,
        status: result.match.status,
      });

      const definition = (await this.store.listTriggers()).find(
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
        await this.observability?.emit({
          event: 'ei.match.definition_missing',
          level: 'error',
          traceId: event.traceId,
          triggerId: result.triggerId,
          matchId: result.match.matchId,
          status: 'trigger_definition_missing',
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
        await this.observability?.emit({
          event: 'ei.wake.runtime_unconfigured',
          level: 'warn',
          traceId: event.traceId,
          triggerId: result.triggerId,
          matchId: result.match.matchId,
          status: 'runtime_unconfigured',
          metadata: { runtime: definition.target.runtime },
        });
        continue;
      }

      const delivery = await coordinator.deliverMatched(result.match);
      const persistedWake = delivery.wake;

      deliveries.push({
        triggerId: result.triggerId,
        matchId: result.match.matchId,
        wakeId: persistedWake?.wakeId ?? null,
        status: delivery.status,
        runtimeReceiptId: persistedWake?.runtimeReceiptId ?? null,
      });
    }

    return {
      event,
      results,
      deliveries,
      derivedEvents,
    };
  }
}
