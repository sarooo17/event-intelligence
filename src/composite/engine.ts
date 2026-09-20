import { SemanticConditionEngine } from '../semantic/conditionEngine.js';
import type { SemanticEvaluator } from '../semantic/types.js';
import { sha256Hex } from '../intelligenceProtocol/canonical.js';
import {
  COMPOSITE_TRIGGER_PROTOCOL_VERSION,
  COMPOSITE_TRIGGER_SCHEMA_VERSION,
  CompositeTriggerDefinitionSchema,
  CorrelatableEventSchema,
  TriggerMatchRecordSchema,
  type CompositeTriggerDefinition,
  type CorrelatableEvent,
  type TriggerClause,
  type TriggerMatchRecord,
} from '../intelligenceProtocol/triggerSchemas.js';
import {
  evaluateTemporalConditions,
} from './temporal.js';
import {
  asSourceEvent,
  clauseMatches,
  deterministicKeyForClause,
  expressionSatisfied,
  matchesCorrelationKey,
  sameEventIdentity,
  semanticSource,
} from './matching.js';
import { assertNoDerivedEventCycle } from './derivedGraph.js';
import {
  CompositeTriggerRuntimeSupport,
} from './runtimeSupport.js';
import type {
  CompositeTriggerAudit,
  CompositeTriggerStore,
} from './store.js';

export type {
  CompositeTriggerAudit,
  CompositeTriggerStore,
} from './store.js';

export interface CompositeIngestResult {
  triggerId: string;
  match: TriggerMatchRecord | null;
  matched: boolean;
  fired: boolean;
}

export class CompositeTriggerEngine {
  private readonly support: CompositeTriggerRuntimeSupport;

  constructor(
    private readonly store: CompositeTriggerStore & CompositeTriggerAudit,
    private readonly evaluator: SemanticEvaluator | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.support = new CompositeTriggerRuntimeSupport(store, now);
  }

  async register(definitionInput: unknown): Promise<CompositeTriggerDefinition> {
    const definition = CompositeTriggerDefinitionSchema.parse(definitionInput);
    assertNoDerivedEventCycle(
      this.store.listTriggers(),
      definition,
      this.store.getTriggerState?.bind(this.store),
    );
    await this.store.putTrigger(definition);
    return definition;
  }

  async ingest(eventInput: unknown): Promise<CompositeIngestResult[]> {
    const event = CorrelatableEventSchema.parse(eventInput);

    if (event.name === 'event-intelligence.timer.reached') {
      return this.ingestTimerEvent(event);
    }

    const results: CompositeIngestResult[] = [];

    for (const definition of this.store.listTriggers()) {
      const triggerState = this.store.getTriggerState?.(
        definition.triggerId,
        definition.version,
      ) ?? null;
      if (!(await this.support.lifecycleAllows(definition, triggerState, this.now()))) {
        continue;
      }

      const matchingClauses = definition.clauses.filter((clause) =>
        clauseMatches(clause, event),
      );
      if (matchingClauses.length === 0) continue;

      const replayed = this.store
        .listTriggerMatches(definition.triggerId)
        .find((record) =>
          record.sourceEvents.some(
            (source) => sameEventIdentity(source, event),
          ),
        );

      if (replayed) {
        results.push({
          triggerId: definition.triggerId,
          match: replayed,
          matched:
            replayed.status === 'matched' ||
            replayed.status === 'emitted' ||
            replayed.status === 'fired',
          fired: replayed.status === 'fired',
        });
        continue;
      }

      const clause = matchingClauses[0]!;
      results.push(await this.applyEvent(definition, clause, event));
    }

    return results;
  }

  async markFired(matchId: string, wakeId: string): Promise<TriggerMatchRecord> {
    const latest = this.latestMatch(matchId);
    if (!latest) throw new Error(`Unknown trigger match: ${matchId}`);
    if (latest.status === 'fired') return latest;
    if (latest.status !== 'matched') {
      throw new Error(
        `Trigger match must be matched before firing; current=${latest.status}`,
      );
    }

    const fired = TriggerMatchRecordSchema.parse({
      ...latest,
      status: 'fired',
      firedWakeId: wakeId,
      updatedAt: this.now().toISOString(),
    });
    await this.store.appendTriggerMatch(fired);
    await this.support.cancelDeadlinesForMatch(matchId);
    await this.support.auditMatch(fired, 'trigger.fired', { wakeId });

    await this.support.advanceLifecycleAfterEffect(
      fired,
      'wake',
      wakeId,
    );

    return fired;
  }

  async markDerivedEmitted(
    matchId: string,
    derivedEventId: string,
  ): Promise<TriggerMatchRecord> {
    const latest = this.latestMatch(matchId);
    if (!latest) throw new Error(`Unknown trigger match: ${matchId}`);
    if (
      latest.status === 'emitted' &&
      latest.derivedEventIds.includes(derivedEventId)
    ) {
      return latest;
    }
    if (latest.status !== 'matched') {
      throw new Error(
        `Trigger match must be matched before derived emission; current=${latest.status}`,
      );
    }

    const emitted = TriggerMatchRecordSchema.parse({
      ...latest,
      status: 'emitted',
      updatedAt: this.now().toISOString(),
      derivedEventIds: [
        ...new Set([...latest.derivedEventIds, derivedEventId]),
      ],
    });
    await this.store.appendTriggerMatch(emitted);
    await this.support.cancelDeadlinesForMatch(matchId);
    await this.support.auditMatch(emitted, 'trigger.emitted', {
      derivedEventId,
    });
    await this.support.advanceLifecycleAfterEffect(
      emitted,
      'derived_event',
      derivedEventId,
    );
    return emitted;
  }

  private async ingestTimerEvent(
    event: CorrelatableEvent,
  ): Promise<CompositeIngestResult[]> {
    const deadlineId = String(event.data.deadlineId ?? '');
    if (!deadlineId || !this.store.getTemporalDeadline) return [];

    const deadline = this.store.getTemporalDeadline(deadlineId);
    if (!deadline || deadline.status !== 'pending') return [];

    const definition = this.store.listTriggers().find(
      (candidate) =>
        candidate.triggerId === deadline.triggerId &&
        candidate.version === deadline.triggerVersion,
    );
    if (!definition) return [];

    const triggerState = this.store.getTriggerState?.(
      definition.triggerId,
      definition.version,
    ) ?? null;
    if (!(await this.support.lifecycleAllows(definition, triggerState, this.now()))) {
      return [];
    }

    const match = this.latestMatch(deadline.matchId);
    if (
      !match ||
      match.status === 'matched' ||
      match.status === 'emitted' ||
      match.status === 'fired' ||
      match.status === 'expired'
    ) {
      return [];
    }

    if (Date.parse(event.occurredAt) > Date.parse(match.expiresAt)) {
      const expired = TriggerMatchRecordSchema.parse({
        ...match,
        status: 'expired',
        updatedAt: event.occurredAt,
      });
      await this.store.appendTriggerMatch(expired);
      await this.support.cancelDeadlinesForMatch(expired.matchId);
      await this.support.auditMatch(expired, 'trigger.expired', {
        reason: 'temporal_deadline_after_event_window',
      });
      return [{
        triggerId: definition.triggerId,
        match: expired,
        matched: false,
        fired: false,
      }];
    }

    const result = await this.finalizeEligible(
      definition,
      match,
      new Date(event.occurredAt),
    );
    return [result];
  }

  private async applyEvent(
    definition: CompositeTriggerDefinition,
    clause: TriggerClause,
    event: CorrelatableEvent,
  ): Promise<CompositeIngestResult> {
    const nowIso = this.now().toISOString();
    const eventTime = Date.parse(event.occurredAt);
    const key = deterministicKeyForClause(definition, clause.id, event);

    const existing = this.store
      .listTriggerMatches(definition.triggerId)
      .filter((record) =>
        record.triggerVersion === definition.version &&
        (record.status === 'partial' || record.status === 'matched') &&
        matchesCorrelationKey(record, key),
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];

    if (existing?.status === 'matched') {
      return {
        triggerId: definition.triggerId,
        match: existing,
        matched: true,
        fired: false,
      };
    }

    let record = existing ?? await this.newMatch(definition, key, event);

    if (Date.parse(record.expiresAt) < eventTime) {
      const expired = TriggerMatchRecordSchema.parse({
        ...record,
        status: 'expired',
        updatedAt: nowIso,
      });
      await this.store.appendTriggerMatch(expired);
      await this.support.cancelDeadlinesForMatch(expired.matchId);
      await this.support.auditMatch(expired, 'trigger.expired', {
        reason: 'window_expired_before_event',
      });
      record = await this.newMatch(definition, key, event);
    }

    const duplicate = record.sourceEvents.some(
      (candidate) => sameEventIdentity(candidate, event),
    );

    if (!duplicate) {
      record = TriggerMatchRecordSchema.parse({
        ...record,
        correlationKey: record.correlationKey ?? key,
        updatedAt: nowIso,
        sourceEvents: [
          ...record.sourceEvents,
          asSourceEvent(clause.id, event),
        ],
      });
    }

    if (!expressionSatisfied(definition, record)) {
      await this.store.appendTriggerMatch(record);
      await this.support.auditMatch(record, 'trigger.partial', {
        clauseId: clause.id,
        sourceEventId: event.sourceEventId,
      });
      return {
        triggerId: definition.triggerId,
        match: record,
        matched: false,
        fired: false,
      };
    }

    return this.finalizeEligible(definition, record, this.now());
  }

  private async finalizeEligible(
    definition: CompositeTriggerDefinition,
    record: TriggerMatchRecord,
    evaluationNow: Date,
  ): Promise<CompositeIngestResult> {
    const nowIso = evaluationNow.toISOString();

    const temporal = evaluateTemporalConditions(
      definition,
      record,
      evaluationNow,
    );

    if (temporal.outcome === 'blocked') {
      const expired = TriggerMatchRecordSchema.parse({
        ...record,
        status: 'expired',
        updatedAt: nowIso,
      });
      await this.store.appendTriggerMatch(expired);
      await this.support.cancelDeadlinesForMatch(expired.matchId);
      await this.support.auditMatch(expired, 'trigger.expired', {
        reason: 'temporal_condition_blocked',
        temporal: temporal.conditionStates,
      });
      return {
        triggerId: definition.triggerId,
        match: expired,
        matched: false,
        fired: false,
      };
    }

    if (temporal.outcome === 'pending') {
      await this.store.appendTriggerMatch(
        TriggerMatchRecordSchema.parse({
          ...record,
          status: 'partial',
          updatedAt: nowIso,
        }),
      );
      await this.support.scheduleDeadlines(
        definition,
        record,
        temporal.pendingDeadlines,
      );
      await this.support.auditMatch(record, 'trigger.partial', {
        reason: 'temporal_wait',
        temporal: temporal.conditionStates,
      });
      return {
        triggerId: definition.triggerId,
        match: record,
        matched: false,
        fired: false,
      };
    }

    await this.support.cancelDeadlinesForMatch(record.matchId);

    if (definition.correlation?.semantic) {
      if (!this.evaluator) {
        await this.store.appendTriggerMatch(record);
        await this.support.auditMatch(record, 'trigger.partial', {
          reason: 'semantic_evaluator_unavailable',
        });
        return {
          triggerId: definition.triggerId,
          match: record,
          matched: false,
          fired: false,
        };
      }

      const semantic = definition.correlation.semantic;
      const decision = await new SemanticConditionEngine(this.evaluator).evaluate(
        semanticSource(record),
        {
          type: 'semantic_boolean',
          instruction: semantic.instruction,
          input: semantic.input,
          matchThreshold: semantic.matchThreshold,
          rejectThreshold: semantic.rejectThreshold,
          uncertain: semantic.uncertain,
        },
      );

      record = TriggerMatchRecordSchema.parse({
        ...record,
        correlationDecision: {
          evaluator: decision.evaluator,
          outcome: decision.outcome,
          probability: decision.probability,
          matched: decision.matched,
          shouldEscalate: decision.shouldEscalate,
          inputFields: semantic.input,
          ...(decision.metadata ? { providerEvidence: decision.metadata } : {}),
          evaluatedAt: nowIso,
        },
        updatedAt: nowIso,
      });

      await this.store.appendTriggerMatch(record);
      await this.support.auditMatch(record, 'trigger.correlation', {
        outcome: decision.outcome,
        probability: decision.probability,
        evaluator: decision.evaluator,
      });

      if (!decision.matched) {
        return {
          triggerId: definition.triggerId,
          match: record,
          matched: false,
          fired: false,
        };
      }
    }

    const matched = TriggerMatchRecordSchema.parse({
      ...record,
      status: 'matched',
      updatedAt: nowIso,
    });
    await this.store.appendTriggerMatch(matched);
    await this.support.auditMatch(matched, 'trigger.matched', {
      sourceEventIds: matched.sourceEvents.map((item) => item.sourceEventId),
      temporal: temporal.conditionStates,
    });

    return {
      triggerId: definition.triggerId,
      match: matched,
      matched: true,
      fired: false,
    };
  }

  private async newMatch(
    definition: CompositeTriggerDefinition,
    key: string | null,
    event: CorrelatableEvent,
  ): Promise<TriggerMatchRecord> {
    const openedAt = event.occurredAt;
    const expiresAt = new Date(
      Date.parse(openedAt) + definition.withinMs,
    ).toISOString();
    const matchId = `tm_${(
      await sha256Hex(
        [
          definition.triggerId,
          definition.version,
          key ?? '-',
          event.sourceEventId,
        ].join(':'),
      )
    ).slice(0, 24)}`;

    return TriggerMatchRecordSchema.parse({
      protocolVersion: COMPOSITE_TRIGGER_PROTOCOL_VERSION,
      schemaVersion: COMPOSITE_TRIGGER_SCHEMA_VERSION,
      matchId,
      triggerId: definition.triggerId,
      triggerVersion: definition.version,
      status: 'partial',
      correlationKey: key,
      openedAt,
      expiresAt,
      updatedAt: this.now().toISOString(),
      sourceEvents: [],
      correlationDecision: null,
      firedWakeId: null,
      derivedEventIds: [],
    });
  }

  private latestMatch(matchId: string): TriggerMatchRecord | null {
    return this.store
      .listTriggerMatches()
      .filter((record) => record.matchId === matchId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
  }


}
