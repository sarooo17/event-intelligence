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

export class CompositeWakeCoordinator {
  constructor({
    store,
    triggerEngine,
    deliverer = null,
    packetBuilder = buildGenericRuntimeWakePacket,
    now = () => new Date(),
  }) {
    this.store = store;
    this.triggerEngine = triggerEngine;
    this.deliverer = deliverer;
    this.packetBuilder = packetBuilder;
    this.now = now;
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

    const existing = this.store.latestWake(wakeId);
    if (existing?.status === 'handled' || existing?.status === 'delivered') {
      if (match.status !== 'fired') {
        await this.triggerEngine.markFired(match.matchId, wakeId);
      }
      return {
        status: existing.status === 'handled' ? 'handled' : 'wake_delivered',
        wake: existing,
      };
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

    if (!existing || existing.status === 'dead_letter') {
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

    if (!this.deliverer) {
      return { status: 'wake_queued', wake: queued };
    }

    try {
      const packet = this.packetBuilder({
        wakeId,
        match,
        definition,
      });
      const receipt = await this.deliverer(packet);

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
          composite: true,
        },
      });

      await this.triggerEngine.markFired(match.matchId, wakeId);

      return {
        status: 'wake_delivered',
        wake: delivered,
        packet,
      };
    } catch (error) {
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
          message: error instanceof Error ? error.message : 'wake delivery failed',
          composite: true,
        },
      });
      return {
        status: 'dead_letter',
        wake: deadLetter,
        error,
      };
    }
  }
}
