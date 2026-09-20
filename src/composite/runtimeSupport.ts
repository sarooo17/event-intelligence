import { sha256Hex } from '../intelligenceProtocol/canonical.js';
import type {
  CompositeTriggerDefinition,
  TriggerMatchRecord,
} from '../intelligenceProtocol/triggerSchemas.js';
import type {
  CompositeTriggerAudit,
  CompositeTriggerStore,
} from './store.js';

type TriggerState = {
  status: 'active' | 'paused' | 'completed' | 'expired' | 'deleted';
  owner?: unknown;
  connectionIds?: string[];
  fireCount?: number;
  lastFiredAt?: string | null;
};

export class CompositeTriggerRuntimeSupport {
  constructor(
    private readonly store: CompositeTriggerStore & CompositeTriggerAudit,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async scheduleDeadlines(
    definition: CompositeTriggerDefinition,
    record: TriggerMatchRecord,
    deadlines: Array<{ conditionId: string; dueAt: string }>,
  ): Promise<void> {
    if (!this.store.putTemporalDeadline) return;

    for (const deadline of deadlines) {
      const deadlineId = `td_${(
        await sha256Hex(
          [
            definition.triggerId,
            definition.version,
            record.matchId,
            deadline.conditionId,
            deadline.dueAt,
          ].join(':'),
        )
      ).slice(0, 24)}`;
      const existing = this.store.getTemporalDeadline?.(deadlineId);
      if (existing?.status === 'pending' || existing?.status === 'fired') {
        continue;
      }

      await this.store.putTemporalDeadline({
        deadlineId,
        triggerId: definition.triggerId,
        triggerVersion: definition.version,
        matchId: record.matchId,
        conditionId: deadline.conditionId,
        dueAt: deadline.dueAt,
        status: 'pending',
      });
    }
  }

  async cancelDeadlinesForMatch(matchId: string): Promise<void> {
    if (
      !this.store.listTemporalDeadlines ||
      !this.store.setTemporalDeadlineStatus
    ) return;

    const pending = this.store.listTemporalDeadlines({
      matchId,
      status: 'pending',
    });
    for (const deadline of pending) {
      await this.store.setTemporalDeadlineStatus(
        deadline.deadlineId,
        'cancelled',
      );
    }
  }

  async advanceLifecycleAfterEffect(
    match: TriggerMatchRecord,
    effectKind: 'wake' | 'derived_event',
    effectId: string,
  ): Promise<void> {
    const definition = this.store.listTriggers().find(
      (candidate) =>
        candidate.triggerId === match.triggerId &&
        candidate.version === match.triggerVersion,
    );
    const triggerState = this.store.getTriggerState?.(
      match.triggerId,
      match.triggerVersion,
    ) ?? null;

    if (!definition || !this.store.setTriggerState) return;

    const previousCount = triggerState?.fireCount ?? 0;
    const fireCount = previousCount + 1;
    const lifecycle = definition.lifecycle ?? {};
    const complete =
      lifecycle.oneShot === true ||
      lifecycle.completeOnGoal === true ||
      (
        lifecycle.maxFirings !== undefined &&
        fireCount >= lifecycle.maxFirings
      );
    const nextStatus = complete ? 'completed' : 'active';
    const effectAt = this.now().toISOString();

    await this.store.setTriggerState(
      match.triggerId,
      match.triggerVersion,
      nextStatus,
      {
        type: 'system',
        principal_id: 'event-intelligence:lifecycle',
      },
      {
        owner: triggerState?.owner ?? null,
        connectionIds: triggerState?.connectionIds ?? [],
        fireCount,
        lastFiredAt: effectAt,
      },
    );

    if (complete) {
      await this.auditTriggerLifecycle(
        definition,
        'trigger.completed',
        {
          reason: lifecycle.oneShot
            ? 'one_shot'
            : lifecycle.completeOnGoal
              ? 'complete_on_goal'
              : 'max_firings',
          fireCount,
          effectKind,
          effectId,
        },
      );
    }
  }

  async lifecycleAllows(
    definition: CompositeTriggerDefinition,
    state: TriggerState | null,
    now: Date,
  ): Promise<boolean> {
    const lifecycle = definition.lifecycle ?? {};
    const effectiveState = state ?? {
      status: 'active' as const,
      fireCount: 0,
      lastFiredAt: null,
      connectionIds: [],
      owner: null,
    };

    if (effectiveState.status !== 'active') return false;

    const expiresAt = lifecycle.expiresAt
      ? Date.parse(lifecycle.expiresAt)
      : Number.POSITIVE_INFINITY;
    const leaseUntil = lifecycle.leaseUntil
      ? Date.parse(lifecycle.leaseUntil)
      : Number.POSITIVE_INFINITY;
    if (now.getTime() > Math.min(expiresAt, leaseUntil)) {
      if (this.store.setTriggerState) {
        await this.store.setTriggerState(
          definition.triggerId,
          definition.version,
          'expired',
          {
            type: 'system',
            principal_id: 'event-intelligence:lifecycle',
          },
          {
            owner: effectiveState.owner ?? null,
            connectionIds: effectiveState.connectionIds ?? [],
            fireCount: effectiveState.fireCount ?? 0,
            lastFiredAt: effectiveState.lastFiredAt ?? null,
          },
        );
      }
      await this.auditTriggerLifecycle(
        definition,
        'trigger.lifecycle_expired',
        {
          expiresAt: lifecycle.expiresAt ?? null,
          leaseUntil: lifecycle.leaseUntil ?? null,
        },
      );
      return false;
    }

    const fireCount = effectiveState.fireCount ?? 0;
    if (
      (lifecycle.oneShot && fireCount >= 1) ||
      (
        lifecycle.maxFirings !== undefined &&
        fireCount >= lifecycle.maxFirings
      )
    ) {
      if (this.store.setTriggerState) {
        await this.store.setTriggerState(
          definition.triggerId,
          definition.version,
          'completed',
          {
            type: 'system',
            principal_id: 'event-intelligence:lifecycle',
          },
          {
            owner: effectiveState.owner ?? null,
            connectionIds: effectiveState.connectionIds ?? [],
            fireCount,
            lastFiredAt: effectiveState.lastFiredAt ?? null,
          },
        );
      }
      return false;
    }

    if (
      lifecycle.cooldownMs > 0 &&
      effectiveState.lastFiredAt &&
      now.getTime() - Date.parse(effectiveState.lastFiredAt) <
        lifecycle.cooldownMs
    ) {
      return false;
    }

    return true;
  }

  async auditTriggerLifecycle(
    definition: CompositeTriggerDefinition,
    kind: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const timestamp = this.now().toISOString();
    await this.store.appendAudit({
      auditId: `audit_${(
        await sha256Hex(
          `${definition.triggerId}:${definition.version}:${kind}:${timestamp}`,
        )
      ).slice(0, 24)}`,
      traceId: `trigger:${definition.triggerId}`,
      timestamp,
      kind,
      entityType: 'trigger',
      entityId: definition.triggerId,
      details: {
        triggerVersion: definition.version,
        ...details,
      },
    });
  }

  async auditMatch(
    record: TriggerMatchRecord,
    kind:
      | 'trigger.partial'
      | 'trigger.matched'
      | 'trigger.fired'
      | 'trigger.emitted'
      | 'trigger.expired'
      | 'trigger.correlation',
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.store.appendAudit({
      auditId: `audit_${(
        await sha256Hex(
          `${record.matchId}:${kind}:${record.updatedAt}:${this.store.listTriggerMatches().length}`,
        )
      ).slice(0, 24)}`,
      traceId: record.sourceEvents[0]?.traceId ?? record.matchId,
      timestamp: this.now().toISOString(),
      kind,
      entityType: 'trigger_match',
      entityId: record.matchId,
      details: {
        triggerId: record.triggerId,
        triggerVersion: record.triggerVersion,
        status: record.status,
        correlationKey: record.correlationKey,
        ...details,
      },
    });
  }
}
