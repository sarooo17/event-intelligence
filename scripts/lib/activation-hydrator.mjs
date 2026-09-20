import {
  parseActivationEnvelope,
} from '../../dist/src/intelligenceProtocol/index.js';

function latestMatchForWake(store, wake, delivery) {
  const matchId =
    delivery?.matchId ||
    (wake?.subscriptionId?.startsWith('trigger:') ? wake.sourceEventId : null);
  if (!matchId) return null;

  return store.listTriggerMatches()
    .find((candidate) => candidate.matchId === matchId) ?? null;
}

function definitionForMatch(store, match, delivery) {
  if (!match && !delivery) return null;
  const triggerId = match?.triggerId ?? delivery?.triggerId;
  const triggerVersion = match?.triggerVersion ?? delivery?.triggerVersion;
  return store.listTriggers().find((candidate) =>
    candidate.triggerId === triggerId &&
    candidate.version === triggerVersion
  ) ?? null;
}

function continuationFor(definition) {
  if (definition?.continuation) return definition.continuation;

  const fallback = String(definition?.description || '').trim();
  if (!fallback) return null;
  return {
    instruction: fallback,
    contextPolicy: {
      evidence: 'refs_only',
      maxEvents: 50,
      includeData: false,
    },
  };
}

export class ActivationHydrator {
  constructor({ store }) {
    this.store = store;
  }

  hydrateWake(wakeIdInput) {
    const wakeId = String(wakeIdInput || '').trim();
    if (!wakeId) {
      const error = new Error('wakeId is required');
      error.code = 'ACTIVATION_WAKE_ID_REQUIRED';
      throw error;
    }

    const wake = this.store.latestWake(wakeId);
    if (!wake) {
      const error = new Error(`Unknown wake: ${wakeId}`);
      error.code = 'ACTIVATION_WAKE_NOT_FOUND';
      throw error;
    }

    const delivery =
      typeof this.store.getWakeDelivery === 'function'
        ? this.store.getWakeDelivery(wakeId)
        : null;
    const match = latestMatchForWake(this.store, wake, delivery);
    if (!match) {
      const error = new Error(
        `Wake ${wakeId} is not backed by a composite trigger match`,
      );
      error.code = 'ACTIVATION_TRIGGER_MATCH_NOT_FOUND';
      throw error;
    }

    const definition = definitionForMatch(this.store, match, delivery);
    if (!definition?.target) {
      const error = new Error(
        `Trigger definition missing for wake ${wakeId}`,
      );
      error.code = 'ACTIVATION_TRIGGER_NOT_FOUND';
      throw error;
    }

    const continuation = continuationFor(definition);
    const policy = continuation?.contextPolicy ?? {
      evidence: 'refs_only',
      maxEvents: 50,
      includeData: false,
    };
    const includeData =
      policy.evidence === 'matched_events' &&
      policy.includeData !== false;
    const maxEvents = Math.max(
      1,
      Math.min(50, Number(policy.maxEvents) || 50),
    );

    const evidence = match.sourceEvents.slice(-maxEvents).map((event) => ({
      clauseId: event.clauseId,
      serverId: event.serverId ?? null,
      eventId: event.sourceEventId,
      eventName: event.eventName,
      traceId: event.traceId,
      occurredAt: event.occurredAt,
      payloadHash: event.payloadHash ?? null,
      ...(includeData ? { data: event.data } : {}),
    }));

    return parseActivationEnvelope({
      activationVersion: '1',
      wake: {
        wakeId,
        status: wake.status,
        runtimeReceiptId: wake.runtimeReceiptId ?? null,
        matchedAt: match.updatedAt,
      },
      target: definition.target,
      trigger: {
        triggerId: definition.triggerId,
        version: definition.version,
        description: definition.description ?? null,
        expression: definition.expression,
        lifecycle: definition.lifecycle ?? {},
      },
      continuation,
      match: {
        matchId: match.matchId,
        status: match.status,
        correlationKey: match.correlationKey,
        openedAt: match.openedAt,
        updatedAt: match.updatedAt,
      },
      evidence,
      trust: {
        continuation: 'configured_trigger_instruction',
        evidence: 'untrusted_external_signal',
      },
    });
  }
}

export default { ActivationHydrator };
