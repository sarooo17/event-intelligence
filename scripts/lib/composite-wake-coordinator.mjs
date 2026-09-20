import { randomUUID } from 'node:crypto';
import {
  WakeRecordSchema,
  sha256Hex,
} from '../../dist/src/intelligenceProtocol/index.js';
import {
  buildGenericRuntimeWakePacket,
} from './generic-runtime-wake.mjs';

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

export class CompositeWakeCoordinator {
  constructor({
    store,
    triggerEngine,
    deliverer = null,
    packetBuilder = buildGenericRuntimeWakePacket,
    now = () => new Date(),
    workerId = `wake-worker:${randomUUID()}`,
    leaseMs = 30000,
    maxAttempts = 5,
    retryBaseDelayMs = 1000,
    retryMaxDelayMs = 60000,
  }) {
    this.store = store;
    this.triggerEngine = triggerEngine;
    this.deliverer = deliverer;
    this.packetBuilder = packetBuilder;
    this.now = now;
    this.workerId = workerId;
    this.leaseMs = Math.max(1000, Number(leaseMs) || 30000);
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 5);
    this.retryBaseDelayMs = Math.max(1, Number(retryBaseDelayMs) || 1000);
    this.retryMaxDelayMs = Math.max(
      this.retryBaseDelayMs,
      Number(retryMaxDelayMs) || 60000,
    );

    for (const method of [
      'ensureWakeDelivery',
      'getWakeDelivery',
      'claimWakeDelivery',
      'completeWakeDelivery',
      'failWakeDelivery',
    ]) {
      if (typeof store?.[method] !== 'function') {
        const error = new Error(
          `Wake coordinator store requires ${method}() for durable delivery`,
        );
        error.code = 'WAKE_DELIVERY_STORE_UNSUPPORTED';
        throw error;
      }
    }
  }

  async deliveredResult({ match, wakeId, definition, delivery }) {
    const existing = this.store.latestWake(wakeId);
    let delivered = existing;
    if (
      !delivered ||
      (delivered.status !== 'delivered' && delivered.status !== 'handled')
    ) {
      delivered = WakeRecordSchema.parse({
        wakeId,
        traceId: match.sourceEvents[0]?.traceId ?? match.matchId,
        decisionId: null,
        subscriptionId: `trigger:${match.triggerId}`,
        sourceEventId: match.matchId,
        createdAt: this.now().toISOString(),
        target: definition.target,
        status: 'delivered',
        runtimeReceiptId: delivery.runtimeReceiptId,
      });
      await this.store.appendWake(delivered);
    }

    if (match.status !== 'fired') {
      await this.triggerEngine.markFired(match.matchId, wakeId);
    }

    return {
      status: delivered.status === 'handled' ? 'handled' : 'wake_delivered',
      wake: delivered,
    };
  }

  async deliverMatched(match) {
    if (!match || (match.status !== 'matched' && match.status !== 'fired')) {
      return { status: 'not_matched', wake: null };
    }

    if (match.status === 'fired') {
      const existing = match.firedWakeId
        ? this.store.latestWake(match.firedWakeId)
        : null;
      return {
        status: 'already_fired',
        wake: existing,
      };
    }

    const definition = this.store.listTriggers().find(
      (candidate) =>
        candidate.triggerId === match.triggerId &&
        candidate.version === match.triggerVersion,
    );
    if (!definition) {
      throw new Error(
        `Trigger definition not found for ${match.triggerId}@${match.triggerVersion}`,
      );
    }

    if (!definition.target) {
      return { status: 'no_runtime_target', wake: null };
    }

    const wakeId = await stableId(
      'wake',
      `composite:${match.matchId}:${definition.target.runtime}:${definition.target.id}`,
    );

    const existingWake = this.store.latestWake(wakeId);
    if (existingWake?.status === 'handled' || existingWake?.status === 'delivered') {
      if (match.status !== 'fired') {
        await this.triggerEngine.markFired(match.matchId, wakeId);
      }
      return {
        status: existingWake.status === 'handled' ? 'handled' : 'wake_delivered',
        wake: existingWake,
      };
    }
    if (existingWake?.status === 'dead_letter') {
      return { status: 'dead_letter', wake: existingWake };
    }

    const queued = WakeRecordSchema.parse({
      wakeId,
      traceId: match.sourceEvents[0]?.traceId ?? match.matchId,
      decisionId: null,
      subscriptionId: `trigger:${match.triggerId}`,
      sourceEventId: match.matchId,
      createdAt: this.now().toISOString(),
      target: definition.target,
      status: 'queued',
    });

    if (!this.deliverer) {
      if (!existingWake) {
        await this.store.appendWake(queued);
        await this.store.appendAudit({
          auditId: await stableId(
            'audit',
            `${wakeId}:queued:${this.store.auditLength()}`,
          ),
          traceId: queued.traceId,
          timestamp: this.now().toISOString(),
          kind: 'wake.queued',
          entityType: 'wake',
          entityId: wakeId,
          toState: 'wake_queued',
          details: {
            triggerMatchId: match.matchId,
            triggerId: match.triggerId,
            composite: true,
          },
        });
      }
      return {
        status: 'wake_queued',
        wake: this.store.latestWake(wakeId) ?? queued,
      };
    }

    const nowIso = this.now().toISOString();
    await this.store.ensureWakeDelivery({
      wakeId,
      matchId: match.matchId,
      triggerId: match.triggerId,
      triggerVersion: match.triggerVersion,
      runtime: definition.target.runtime,
      now: nowIso,
    });

    const currentDelivery = this.store.getWakeDelivery(wakeId);
    if (currentDelivery?.status === 'delivered') {
      return this.deliveredResult({
        match,
        wakeId,
        definition,
        delivery: currentDelivery,
      });
    }
    if (currentDelivery?.status === 'dead_letter') {
      const deadLetter = existingWake?.status === 'dead_letter'
        ? existingWake
        : WakeRecordSchema.parse({
            ...queued,
            createdAt: this.now().toISOString(),
            status: 'dead_letter',
          });
      if (existingWake?.status !== 'dead_letter') {
        await this.store.appendWake(deadLetter);
      }
      return { status: 'dead_letter', wake: deadLetter };
    }

    const claim = await this.store.claimWakeDelivery(wakeId, {
      workerId: this.workerId,
      now: nowIso,
      leaseMs: this.leaseMs,
    });

    if (!claim) {
      const delivery = this.store.getWakeDelivery(wakeId);
      return {
        status:
          delivery?.status === 'claimed'
            ? 'delivery_in_progress'
            : 'retry_scheduled',
        wake: this.store.latestWake(wakeId) ?? queued,
        delivery,
      };
    }

    let persistedQueued = this.store.latestWake(wakeId);
    if (!persistedQueued) {
      await this.store.appendWake(queued);
      persistedQueued = queued;
      await this.store.appendAudit({
        auditId: await stableId(
          'audit',
          `${wakeId}:queued:${this.store.auditLength()}`,
        ),
        traceId: queued.traceId,
        timestamp: this.now().toISOString(),
        kind: 'wake.queued',
        entityType: 'wake',
        entityId: wakeId,
        toState: 'wake_queued',
        details: {
          triggerMatchId: match.matchId,
          triggerId: match.triggerId,
          composite: true,
        },
      });
    }

    try {
      const packet = this.packetBuilder({
        wakeId,
        match,
        definition,
      });
      const receipt = await this.deliverer(packet);
      if (
        !receipt ||
        typeof receipt.runtimeReceiptId !== 'string' ||
        !receipt.runtimeReceiptId
      ) {
        throw new Error('Wake deliverer must return runtimeReceiptId');
      }

      const delivery = await this.store.completeWakeDelivery(wakeId, {
        workerId: this.workerId,
        runtimeReceiptId: receipt.runtimeReceiptId,
        now: this.now().toISOString(),
      });

      const delivered = WakeRecordSchema.parse({
        ...queued,
        createdAt: this.now().toISOString(),
        status: 'delivered',
        runtimeReceiptId: receipt.runtimeReceiptId,
      });
      await this.store.appendWake(delivered);
      await this.store.appendAudit({
        auditId: await stableId(
          'audit',
          `${wakeId}:delivered:${this.store.auditLength()}`,
        ),
        traceId: delivered.traceId,
        timestamp: this.now().toISOString(),
        kind: 'wake.delivered',
        entityType: 'wake',
        entityId: wakeId,
        fromState: 'wake_queued',
        toState: 'wake_delivered',
        details: {
          triggerMatchId: match.matchId,
          runtimeReceiptId: delivered.runtimeReceiptId,
          duplicate: receipt.duplicate === true,
          attemptCount: delivery?.attemptCount ?? claim.attemptCount,
          composite: true,
        },
      });

      await this.triggerEngine.markFired(match.matchId, wakeId);

      return {
        status: 'wake_delivered',
        wake: delivered,
        packet,
        delivery,
      };
    } catch (error) {
      const delay = retryDelayMs(
        claim.attemptCount,
        this.retryBaseDelayMs,
        this.retryMaxDelayMs,
      );
      const failureAt = this.now();
      const delivery = await this.store.failWakeDelivery(wakeId, {
        workerId: this.workerId,
        error,
        now: failureAt.toISOString(),
        maxAttempts: this.maxAttempts,
        nextAttemptAt: new Date(failureAt.getTime() + delay).toISOString(),
      });

      if (delivery?.status !== 'dead_letter') {
        await this.store.appendAudit({
          auditId: await stableId(
            'audit',
            `${wakeId}:retry:${delivery?.attemptCount ?? claim.attemptCount}:${this.store.auditLength()}`,
          ),
          traceId: queued.traceId,
          timestamp: this.now().toISOString(),
          kind: 'wake.retry_scheduled',
          entityType: 'wake',
          entityId: wakeId,
          details: {
            triggerMatchId: match.matchId,
            attemptCount: delivery?.attemptCount ?? claim.attemptCount,
            nextAttemptAt: delivery?.nextAttemptAt ?? null,
            message: error instanceof Error ? error.message : 'wake delivery failed',
            composite: true,
          },
        });
        return {
          status: 'retry_scheduled',
          wake: persistedQueued,
          delivery,
          error,
        };
      }

      const deadLetter = WakeRecordSchema.parse({
        ...queued,
        createdAt: this.now().toISOString(),
        status: 'dead_letter',
      });
      await this.store.appendWake(deadLetter);
      await this.store.appendAudit({
        auditId: await stableId(
          'audit',
          `${wakeId}:dead-letter:${this.store.auditLength()}`,
        ),
        traceId: deadLetter.traceId,
        timestamp: this.now().toISOString(),
        kind: 'wake.dead_letter',
        entityType: 'wake',
        entityId: wakeId,
        fromState: 'wake_queued',
        toState: 'dead_letter',
        details: {
          triggerMatchId: match.matchId,
          attemptCount: delivery?.attemptCount ?? claim.attemptCount,
          message: error instanceof Error ? error.message : 'wake delivery failed',
          composite: true,
        },
      });
      return {
        status: 'dead_letter',
        wake: deadLetter,
        delivery,
        error,
      };
    }
  }
}
