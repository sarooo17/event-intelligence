import { randomUUID } from 'node:crypto';
import {
  assertDecisionLineage,
  assertWakeLineage,
  mapMcpEventToLineage,
  parseEventIngestRequest,
  SemanticDecisionRecordSchema,
  WakeRecordSchema,
  sha256Hex,
} from '../../dist/src/intelligenceProtocol/index.js';
import {
  SemanticConditionEngine,
} from '../../dist/src/semantic/conditionEngine.js';

function nowIso(now) {
  return now().toISOString();
}

async function stableId(prefix, value) {
  const hash = await sha256Hex(value);
  return `${prefix}_${hash.slice(0, 24)}`;
}

function retryDelayMs(attemptCount, baseDelayMs, maxDelayMs) {
  return Math.min(
    maxDelayMs,
    baseDelayMs * (2 ** Math.max(0, attemptCount - 1)),
  );
}

export class EventProcessor {
  constructor({
    store,
    evaluator = null,
    wakeDeliverer = null,
    now = () => new Date(),
    workerId = `event-wake-worker:${randomUUID()}`,
    leaseMs = 30000,
    maxAttempts = 5,
    retryBaseDelayMs = 1000,
    retryMaxDelayMs = 60000,
  }) {
    this.store = store;
    this.evaluator = evaluator;
    this.wakeDeliverer = wakeDeliverer;
    this.now = now;
    this.workerId = workerId;
    this.leaseMs = Math.max(1000, Number(leaseMs) || 30000);
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 5);
    this.retryBaseDelayMs = Math.max(1, Number(retryBaseDelayMs) || 1000);
    this.retryMaxDelayMs = Math.max(
      this.retryBaseDelayMs,
      Number(retryMaxDelayMs) || 60000,
    );
  }

  async ingest(rawRequest) {
    const request = parseEventIngestRequest(rawRequest);
    const traceId =
      request.context.traceId ??
      (await stableId(
        'trace',
        [
          request.context.environmentId,
          request.context.subscriptionId,
          request.event.eventId,
        ].join(':'),
      ));

    const lineage = await mapMcpEventToLineage({
      event: request.event,
      traceId,
      environmentId: request.context.environmentId,
      subscriptionId: request.context.subscriptionId,
      serverId: request.context.serverId,
      transport: request.context.transport,
      provider: request.context.provider,
      target: request.context.target,
      observedAt: nowIso(this.now),
    });

    const accepted = await this.store.registerEvent({
      lineage,
      event: request.event,
    });

    if (!accepted) {
      await this.store.appendAudit({
        auditId: await stableId('audit', `${traceId}:duplicate:${this.store.auditLength()}`),
        traceId,
        timestamp: nowIso(this.now),
        kind: 'event.duplicate',
        entityType: 'event',
        entityId: request.event.eventId,
        toState: 'duplicate',
        details: {
          subscriptionId: request.context.subscriptionId,
        },
      });

      return {
        traceId,
        sourceEventId: request.event.eventId,
        status: 'duplicate',
        wake: null,
      };
    }

    await this.store.appendAudit({
      auditId: await stableId('audit', `${traceId}:received`),
      traceId,
      timestamp: nowIso(this.now),
      kind: 'event.received',
      entityType: 'event',
      entityId: request.event.eventId,
      toState: 'received',
      details: {
        eventName: request.event.name,
        payloadHash: lineage.event.payloadHash,
      },
    });

    let state = 'received';
    let decision = null;

    if (request.semanticCondition) {
      if (!this.evaluator) {
        await this.store.appendAudit({
          auditId: await stableId('audit', `${traceId}:semantic-unavailable`),
          traceId,
          timestamp: nowIso(this.now),
          kind: 'error',
          entityType: 'event',
          entityId: request.event.eventId,
          fromState: state,
          toState: 'failed',
          details: { code: 'SEMANTIC_EVALUATOR_UNAVAILABLE' },
        });
        throw new Error('Semantic condition supplied but no evaluator is configured');
      }

      await this.store.appendAudit({
        auditId: await stableId('audit', `${traceId}:evaluating`),
        traceId,
        timestamp: nowIso(this.now),
        kind: 'lifecycle.transition',
        entityType: 'event',
        entityId: request.event.eventId,
        fromState: state,
        toState: 'evaluating',
      });
      state = 'evaluating';

      try {
        const engine = new SemanticConditionEngine(this.evaluator);
        const result = await engine.evaluate(
          { data: request.event.data },
          request.semanticCondition,
        );

        decision = SemanticDecisionRecordSchema.parse({
          decisionId: await stableId('decision', `${traceId}:semantic`),
          traceId,
          subscriptionId: request.context.subscriptionId,
          sourceEventId: request.event.eventId,
          createdAt: nowIso(this.now),
          evaluator: result.evaluator,
          outcome: result.outcome,
          probability: result.probability,
          matched: result.matched,
          shouldEscalate: result.shouldEscalate,
          policy: {
            matchThreshold: request.semanticCondition.matchThreshold,
            rejectThreshold: request.semanticCondition.rejectThreshold,
            uncertain: request.semanticCondition.uncertain,
          },
          inputFields: request.semanticCondition.input,
          providerEvidence: result.metadata
            ? {
                requestedModel:
                  typeof result.metadata.requestedModel === 'string'
                    ? result.metadata.requestedModel
                    : undefined,
                resolvedModel:
                  typeof result.metadata.resolvedModel === 'string'
                    ? result.metadata.resolvedModel
                    : undefined,
                requestId:
                  typeof result.metadata.requestId === 'string'
                    ? result.metadata.requestId
                    : undefined,
                httpStatus:
                  typeof result.metadata.httpStatus === 'number'
                    ? result.metadata.httpStatus
                    : undefined,
                inputTokens:
                  typeof result.metadata.inputTokens === 'number'
                    ? result.metadata.inputTokens
                    : undefined,
                outputTokens:
                  typeof result.metadata.outputTokens === 'number'
                    ? result.metadata.outputTokens
                    : undefined,
                providerReportedCost:
                  typeof result.metadata.cost === 'number'
                    ? result.metadata.cost
                    : undefined,
              }
            : undefined,
        });

        assertDecisionLineage(lineage, decision);
        await this.store.appendDecision(decision);
        await this.store.appendAudit({
          auditId: await stableId('audit', `${traceId}:decision`),
          traceId,
          timestamp: nowIso(this.now),
          kind: 'decision.evaluated',
          entityType: 'decision',
          entityId: decision.decisionId,
          details: {
            evaluator: decision.evaluator,
            outcome: decision.outcome,
            probability: decision.probability,
            inputFields: decision.inputFields,
            providerEvidence: decision.providerEvidence ?? null,
          },
        });

        const nextState =
          result.outcome === 'match'
            ? 'matched'
            : result.outcome === 'reject'
              ? 'rejected'
              : 'escalated';

        await this.store.appendAudit({
          auditId: await stableId('audit', `${traceId}:${nextState}`),
          traceId,
          timestamp: nowIso(this.now),
          kind: 'lifecycle.transition',
          entityType: 'event',
          entityId: request.event.eventId,
          fromState: state,
          toState: nextState,
        });
        state = nextState;

        if (state === 'rejected' || (state === 'escalated' && !request.wakeOnEscalation)) {
          return {
            traceId,
            sourceEventId: request.event.eventId,
            status: state,
            decision,
            wake: null,
          };
        }
      } catch (error) {
        if (state === 'evaluating') {
          await this.store.appendAudit({
            auditId: await stableId('audit', `${traceId}:evaluation-failed`),
            traceId,
            timestamp: nowIso(this.now),
            kind: 'error',
            entityType: 'event',
            entityId: request.event.eventId,
            fromState: state,
            toState: 'failed',
            details: {
              message: error instanceof Error ? error.message : 'semantic evaluation failed',
            },
          });
        }
        throw error;
      }
    } else {
      await this.store.appendAudit({
        auditId: await stableId('audit', `${traceId}:direct-match`),
        traceId,
        timestamp: nowIso(this.now),
        kind: 'lifecycle.transition',
        entityType: 'event',
        entityId: request.event.eventId,
        fromState: state,
        toState: 'matched',
        details: { reason: 'no_semantic_condition' },
      });
      state = 'matched';
    }

    const wakeId = await stableId('wake', `${traceId}:${request.context.target.id}`);
    const queuedWake = WakeRecordSchema.parse({
      wakeId,
      traceId,
      decisionId: decision?.decisionId ?? null,
      subscriptionId: request.context.subscriptionId,
      sourceEventId: request.event.eventId,
      createdAt: nowIso(this.now),
      target: request.context.target,
      status: 'queued',
    });

    assertWakeLineage(lineage, decision, queuedWake);
    await this.store.appendWake(queuedWake);
    await this.store.appendAudit({
      auditId: await stableId('audit', `${traceId}:wake-queued`),
      traceId,
      timestamp: nowIso(this.now),
      kind: 'wake.queued',
      entityType: 'wake',
      entityId: wakeId,
      fromState: state,
      toState: 'wake_queued',
      details: {
        runtime: queuedWake.target.runtime,
        targetKind: queuedWake.target.kind,
        targetId: queuedWake.target.id,
      },
    });

    if (!this.wakeDeliverer) {
      return {
        traceId,
        sourceEventId: request.event.eventId,
        status: 'wake_queued',
        decision,
        wake: queuedWake,
      };
    }

    const deliveryResult = await this.deliverQueuedWake({
      wake: queuedWake,
      lineage,
      event: request.event,
      decision,
    });

    return {
      traceId,
      sourceEventId: request.event.eventId,
      status: deliveryResult.status,
      decision,
      wake: deliveryResult.wake,
    };
  }

  async deliveredWakeFromState(wake, delivery) {
    const latest = this.store.latestWake(wake.wakeId);
    if (latest?.status === 'handled' || latest?.status === 'delivered') {
      return latest;
    }

    const delivered = WakeRecordSchema.parse({
      ...wake,
      createdAt: nowIso(this.now),
      status: 'delivered',
      runtimeReceiptId: delivery.runtimeReceiptId ?? undefined,
    });
    await this.store.appendWake(delivered);
    await this.store.appendAudit({
      auditId: await stableId(
        'audit',
        `${wake.traceId}:wake-delivered-recovered:${this.store.auditLength()}`,
      ),
      traceId: wake.traceId,
      timestamp: nowIso(this.now),
      kind: 'wake.delivered',
      entityType: 'wake',
      entityId: wake.wakeId,
      fromState: 'wake_queued',
      toState: 'wake_delivered',
      details: {
        runtimeReceiptId: delivered.runtimeReceiptId ?? null,
        recoveredFromDeliveryState: true,
      },
    });
    return delivered;
  }

  async deliverQueuedWake({ wake, lineage, event, decision }) {
    if (!this.wakeDeliverer) {
      return { status: 'wake_queued', wake };
    }

    const now = nowIso(this.now);
    await this.store.ensureWakeDelivery({
      wakeId: wake.wakeId,
      sourceType: 'event',
      sourceId: wake.traceId,
      runtime: wake.target.runtime,
      now,
    });

    const current = this.store.getWakeDelivery(wake.wakeId);
    if (current?.status === 'delivered') {
      return {
        status: 'wake_delivered',
        wake: await this.deliveredWakeFromState(wake, current),
      };
    }
    if (current?.status === 'dead_letter') {
      return {
        status: 'dead_letter',
        wake: this.store.latestWake(wake.wakeId) ?? wake,
      };
    }

    const claim = await this.store.claimWakeDelivery(wake.wakeId, {
      workerId: this.workerId,
      now,
      leaseMs: this.leaseMs,
    });
    if (!claim) {
      const delivery = this.store.getWakeDelivery(wake.wakeId);
      return {
        status:
          delivery?.status === 'claimed'
            ? 'delivery_in_progress'
            : 'retry_scheduled',
        wake: this.store.latestWake(wake.wakeId) ?? wake,
      };
    }

    try {
      const receipt = await this.wakeDeliverer({
        wake,
        lineage,
        event,
        decision,
      });
      if (
        !receipt ||
        typeof receipt.runtimeReceiptId !== 'string' ||
        !receipt.runtimeReceiptId
      ) {
        throw new Error('Wake deliverer must return runtimeReceiptId');
      }

      const delivery = await this.store.completeWakeDelivery(wake.wakeId, {
        workerId: this.workerId,
        runtimeReceiptId: receipt.runtimeReceiptId,
        now: nowIso(this.now),
      });
      const deliveredWake = WakeRecordSchema.parse({
        ...wake,
        createdAt: nowIso(this.now),
        status: 'delivered',
        runtimeReceiptId: receipt.runtimeReceiptId,
      });
      await this.store.appendWake(deliveredWake);
      await this.store.appendAudit({
        auditId: await stableId(
          'audit',
          `${wake.traceId}:wake-delivered:${this.store.auditLength()}`,
        ),
        traceId: wake.traceId,
        timestamp: nowIso(this.now),
        kind: 'wake.delivered',
        entityType: 'wake',
        entityId: wake.wakeId,
        fromState: 'wake_queued',
        toState: 'wake_delivered',
        details: {
          runtimeReceiptId: deliveredWake.runtimeReceiptId ?? null,
          attemptCount: delivery?.attemptCount ?? claim.attemptCount,
        },
      });
      return {
        status: 'wake_delivered',
        wake: deliveredWake,
      };
    } catch (error) {
      const failedAt = this.now();
      const delay = retryDelayMs(
        claim.attemptCount,
        this.retryBaseDelayMs,
        this.retryMaxDelayMs,
      );
      const delivery = await this.store.failWakeDelivery(wake.wakeId, {
        workerId: this.workerId,
        error,
        now: failedAt.toISOString(),
        maxAttempts: this.maxAttempts,
        nextAttemptAt: new Date(failedAt.getTime() + delay).toISOString(),
      });

      if (delivery?.status !== 'dead_letter') {
        await this.store.appendAudit({
          auditId: await stableId(
            'audit',
            `${wake.traceId}:wake-retry:${delivery?.attemptCount ?? claim.attemptCount}:${this.store.auditLength()}`,
          ),
          traceId: wake.traceId,
          timestamp: nowIso(this.now),
          kind: 'wake.retry_scheduled',
          entityType: 'wake',
          entityId: wake.wakeId,
          details: {
            attemptCount: delivery?.attemptCount ?? claim.attemptCount,
            nextAttemptAt: delivery?.nextAttemptAt ?? null,
            message:
              error instanceof Error
                ? error.message
                : 'wake delivery failed',
          },
        });
        return {
          status: 'retry_scheduled',
          wake: this.store.latestWake(wake.wakeId) ?? wake,
        };
      }

      const deadLetter = WakeRecordSchema.parse({
        ...wake,
        createdAt: nowIso(this.now),
        status: 'dead_letter',
      });
      await this.store.appendWake(deadLetter);
      await this.store.appendAudit({
        auditId: await stableId(
          'audit',
          `${wake.traceId}:wake-dead-letter:${this.store.auditLength()}`,
        ),
        traceId: wake.traceId,
        timestamp: nowIso(this.now),
        kind: 'wake.dead_letter',
        entityType: 'wake',
        entityId: wake.wakeId,
        fromState: 'wake_queued',
        toState: 'dead_letter',
        details: {
          attemptCount: delivery?.attemptCount ?? claim.attemptCount,
          message:
            error instanceof Error
              ? error.message
              : 'wake delivery failed',
        },
      });
      return {
        status: 'dead_letter',
        wake: deadLetter,
      };
    }
  }

  async retryWake(wakeId) {
    const delivery = this.store.getWakeDelivery(wakeId);
    if (!delivery || delivery.sourceType !== 'event') {
      return { status: 'not_event_wake', wake: null };
    }

    const latest = this.store.latestWake(wakeId);
    if (!latest) {
      throw new Error(`Unknown wake: ${wakeId}`);
    }
    if (latest.status === 'handled') {
      return { status: 'handled', wake: latest };
    }
    if (latest.status === 'dead_letter') {
      return { status: 'dead_letter', wake: latest };
    }

    const trace = this.store.trace(delivery.sourceId);
    const eventRecord = trace.events[0];
    if (!eventRecord?.lineage || !eventRecord?.event) {
      const error = new Error(
        `Cannot reconstruct event wake ${wakeId}; trace ${delivery.sourceId} is missing`,
      );
      error.code = 'WAKE_RETRY_SOURCE_MISSING';
      throw error;
    }

    const decision = latest.decisionId
      ? trace.decisions.find(
          (candidate) => candidate.decisionId === latest.decisionId,
        ) ?? null
      : null;

    const queued = WakeRecordSchema.parse({
      ...latest,
      status: 'queued',
      runtimeReceiptId: undefined,
    });
    return this.deliverQueuedWake({
      wake: queued,
      lineage: eventRecord.lineage,
      event: eventRecord.event,
      decision,
    });
  }

  async acknowledgeWake(wakeId, runtimeReceiptId) {
    const latest = this.store.latestWake(wakeId);
    if (!latest) throw new Error('Unknown wake');
    if (latest.status === 'handled') return latest;
    if (latest.status !== 'delivered') {
      throw new Error(`Wake must be delivered before acknowledgement; current=${latest.status}`);
    }

    const handled = WakeRecordSchema.parse({
      ...latest,
      createdAt: nowIso(this.now),
      status: 'handled',
      runtimeReceiptId: runtimeReceiptId ?? latest.runtimeReceiptId,
    });

    await this.store.appendWake(handled);
    await this.store.appendAudit({
      auditId: await stableId('audit', `${latest.traceId}:wake-handled`),
      traceId: latest.traceId,
      timestamp: nowIso(this.now),
      kind: 'wake.handled',
      entityType: 'wake',
      entityId: wakeId,
      fromState: 'wake_delivered',
      toState: 'handled',
      details: {
        runtimeReceiptId: handled.runtimeReceiptId ?? null,
      },
    });

    return handled;
  }
}
