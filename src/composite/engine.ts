import { SemanticConditionEngine } from '../semantic/conditionEngine.js';
import {
  evaluatePatternV2,
  patternV2CandidateSignature,
  type PatternV2Candidate,
} from '../patternV2/evaluator.js';
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

function clauseAccumulatesOccurrences(
  definition: CompositeTriggerDefinition,
  clauseId: string,
): boolean {
  if (definition.correlation?.semantic) return true;

  if (
    definition.expression.kind === 'count' &&
    definition.expression.ref === clauseId
  ) {
    return true;
  }

  return definition.temporal.some((condition) =>
    (
      condition.kind === 'threshold' ||
      condition.kind === 'rate' ||
      condition.kind === 'distinct' ||
      condition.kind === 'debounce'
    ) &&
    condition.ref === clauseId
  );
}

function getByPath(source: unknown, path: string): unknown {
  let current = source;
  for (const part of path.split('.')) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function sourceEventOrder(
  left: TriggerMatchRecord['sourceEvents'][number],
  right: TriggerMatchRecord['sourceEvents'][number],
): number {
  return (
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
    left.sourceEventId.localeCompare(right.sourceEventId) ||
    left.clauseId.localeCompare(right.clauseId)
  );
}

function stablePatternValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stablePatternValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          stablePatternValue((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function patternPhysicalIdentity(
  event: TriggerMatchRecord['sourceEvents'][number],
): string {
  return [
    event.serverId ?? '-',
    event.sourceEventId,
    JSON.stringify(stablePatternValue(event.subscriptionArguments ?? {})),
  ].join(':');
}

function prospectiveEventWindow(
  record: Pick<TriggerMatchRecord, 'sourceEvents'>,
  event: CorrelatableEvent,
  withinMs: number,
): {
  openedAt: string;
  expiresAt: string;
  spanMs: number;
  fits: boolean;
} {
  const eventTimes = [
    ...record.sourceEvents.map((source) => Date.parse(source.occurredAt)),
    Date.parse(event.occurredAt),
  ];
  const openedMs = Math.min(...eventTimes);
  const latestMs = Math.max(...eventTimes);
  const spanMs = latestMs - openedMs;
  return {
    openedAt: new Date(openedMs).toISOString(),
    expiresAt: new Date(openedMs + withinMs).toISOString(),
    spanMs,
    fits: spanMs <= withinMs,
  };
}

export interface CompositeTriggerEngineOptions {
  workerId?: string;
  partitionLeaseMs?: number;
}

export class CompositeTriggerEngine {
  private readonly support: CompositeTriggerRuntimeSupport;
  private readonly workerId: string;
  private readonly partitionLeaseMs: number;

  constructor(
    private readonly store: CompositeTriggerStore & CompositeTriggerAudit,
    private readonly evaluator: SemanticEvaluator | null = null,
    private readonly now: () => Date = () => new Date(),
    options: CompositeTriggerEngineOptions = {},
  ) {
    this.support = new CompositeTriggerRuntimeSupport(store, now);
    this.workerId =
      String(options.workerId || 'event-intelligence-engine');
    this.partitionLeaseMs = Math.max(
      1000,
      Number(options.partitionLeaseMs) || 300000,
    );
  }

  async register(definitionInput: unknown): Promise<CompositeTriggerDefinition> {
    const definition = CompositeTriggerDefinitionSchema.parse(definitionInput);
    const existingDefinitions = await this.store.listTriggers();
    const stateByTrigger = new Map<string, { status: string } | null>();
    if (this.store.getTriggerState) {
      await Promise.all(existingDefinitions.map(async (existing) => {
        stateByTrigger.set(
          `${existing.triggerId}@${existing.version}`,
          await this.store.getTriggerState!(
            existing.triggerId,
            existing.version,
          ),
        );
      }));
    }
    assertNoDerivedEventCycle(
      existingDefinitions,
      definition,
      (triggerId, version) =>
        stateByTrigger.get(`${triggerId}@${version}`) ?? null,
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

    for (const definition of await this.store.listTriggers()) {
      const triggerState = this.store.getTriggerState
        ? await this.store.getTriggerState(
          definition.triggerId,
          definition.version,
        )
        : null;
      if (!(await this.support.lifecycleAllows(definition, triggerState, this.now()))) {
        continue;
      }

      const matchingClauses = definition.clauses.filter((clause) =>
        clauseMatches(clause, event),
      );
      if (matchingClauses.length === 0) continue;

      if (definition.patternV2) {
        const replayed = (await this.store
          .listTriggerMatches(definition.triggerId))
          .filter((record) =>
            record.triggerVersion === definition.version &&
            record.sourceEvents.some(
              (source) => sameEventIdentity(source, event),
            )
          )
          .sort((a, b) => {
            const rank = (status: TriggerMatchRecord['status']) =>
              status === 'fired'
                ? 4
                : status === 'emitted'
                  ? 3
                  : status === 'matched'
                    ? 2
                    : status === 'partial'
                      ? 1
                      : 0;
            return (
              rank(b.status) - rank(a.status) ||
              Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
            );
          })[0];

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

        results.push(
          ...await this.applyPatternV2(
            definition,
            matchingClauses,
            event,
          ),
        );
        continue;
      }

      const replayed = (await this.store
        .listTriggerMatches(definition.triggerId))
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
    const latest = await this.latestMatch(matchId);
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
    const latest = await this.latestMatch(matchId);
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

    const deadline = await this.store.getTemporalDeadline(deadlineId);
    if (!deadline || deadline.status !== 'pending') return [];

    const definition = (await this.store.listTriggers()).find(
      (candidate) =>
        candidate.triggerId === deadline.triggerId &&
        candidate.version === deadline.triggerVersion,
    );
    if (!definition) return [];

    const triggerState = this.store.getTriggerState
      ? await this.store.getTriggerState(
        definition.triggerId,
        definition.version,
      )
      : null;
    if (!(await this.support.lifecycleAllows(definition, triggerState, this.now()))) {
      return [];
    }

    const match = await this.latestMatch(deadline.matchId);
    if (
      !match ||
      match.status === 'matched' ||
      match.status === 'emitted' ||
      match.status === 'fired' ||
      match.status === 'expired'
    ) {
      return [];
    }

    if (
      definition.patternV2 &&
      match.patternState?.version === '2' &&
      match.patternState.role === 'buffer'
    ) {
      return this.evaluatePatternV2Buffer(
        definition,
        match,
        new Date(event.occurredAt),
      );
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

  private patternPartitionKey(
    definition: CompositeTriggerDefinition,
    matchingClauses: TriggerClause[],
    event: CorrelatableEvent,
  ): string | null {
    const dimensions = definition.patternV2?.partitionBy ?? [];
    if (!dimensions.length) return null;

    const clauseIds = new Set(matchingClauses.map((clause) => clause.id));
    const components: Array<{
      key: string;
      type: 'string' | 'number' | 'boolean';
      value: string | number | boolean;
    }> = [];

    for (const dimension of dimensions) {
      const fields = dimension.fields.filter((field) =>
        clauseIds.has(field.ref)
      );
      if (!fields.length) {
        throw new Error(
          `Pattern partition ${dimension.key} has no field for incoming event ${event.name}`,
        );
      }

      const values = fields.map((field) => getByPath(event.data, field.path));
      const first = values[0];
      if (
        first === undefined ||
        first === null ||
        !['string', 'number', 'boolean'].includes(typeof first)
      ) {
        throw new Error(
          `Pattern partition ${dimension.key} resolved to a non-scalar value`,
        );
      }
      if (
        values.some(
          (value) =>
            typeof value !== typeof first ||
            value !== first,
        )
      ) {
        throw new Error(
          `Pattern partition ${dimension.key} is ambiguous for incoming event ${event.name}`,
        );
      }
      components.push({
        key: dimension.key,
        type: typeof first as 'string' | 'number' | 'boolean',
        value: first as string | number | boolean,
      });
    }

    return JSON.stringify(components);
  }

  private async patternBufferId(
    definition: CompositeTriggerDefinition,
    key: string | null,
  ): Promise<string> {
    return `tm_${(
      await sha256Hex([
        definition.triggerId,
        definition.version,
        key ?? '-',
        'pattern-v2-buffer',
      ].join(':'))
    ).slice(0, 24)}`;
  }

  private patternDecisionRecord(
    item: PatternV2Candidate['semanticDecisions'][number],
    evaluatedAt: string,
  ) {
    const decision = item.decision;
    return {
      nodeId: item.nodeId,
      decision: {
        evaluator: decision.evaluator,
        outcome: decision.outcome,
        probability: decision.probability,
        matched: decision.matched,
        shouldEscalate: decision.shouldEscalate,
        inputFields: decision.condition.input,
        ...(decision.metadata
          ? { providerEvidence: decision.metadata }
          : {}),
        evaluatedAt,
      },
    };
  }

  private async applyPatternV2(
    definition: CompositeTriggerDefinition,
    matchingClauses: TriggerClause[],
    event: CorrelatableEvent,
  ): Promise<CompositeIngestResult[]> {
    const key = this.patternPartitionKey(
      definition,
      matchingClauses,
      event,
    );
    const capabilities = this.store.storeCapabilities?.();
    const distributedLeases =
      capabilities?.partitionLeases === 'distributed-atomic';

    if (!distributedLeases) {
      return this.applyPatternV2WithPartition(
        definition,
        matchingClauses,
        event,
        key,
      );
    }

    if (
      !this.store.claimPartitionLease ||
      !this.store.releasePartitionLease
    ) {
      const error = new Error(
        'Distributed Pattern v2 store is missing partition lease methods',
      );
      (error as Error & { code?: string }).code =
        'PATTERN_PARTITION_LEASE_UNSUPPORTED';
      throw error;
    }

    const leaseKey = [
      definition.triggerId,
      definition.version,
      key ?? '-',
    ].join(':');
    const nowIso = this.now().toISOString();
    const lease = await this.store.claimPartitionLease(leaseKey, {
      workerId: this.workerId,
      now: nowIso,
      leaseMs: this.partitionLeaseMs,
    });
    if (!lease) {
      const error = new Error(
        `Pattern partition is currently owned by another worker: ${leaseKey}`,
      );
      (error as Error & { code?: string }).code =
        'PATTERN_PARTITION_LEASE_BUSY';
      throw error;
    }

    try {
      return await this.applyPatternV2WithPartition(
        definition,
        matchingClauses,
        event,
        key,
      );
    } finally {
      await this.store.releasePartitionLease(leaseKey, {
        workerId: this.workerId,
        now: this.now().toISOString(),
      });
    }
  }

  private async applyPatternV2WithPartition(
    definition: CompositeTriggerDefinition,
    matchingClauses: TriggerClause[],
    event: CorrelatableEvent,
    key: string | null,
  ): Promise<CompositeIngestResult[]> {
    const pattern = definition.patternV2;
    if (!pattern) return [];

    const now = this.now();
    const nowIso = now.toISOString();
    const bufferId = await this.patternBufferId(definition, key);
    const existing = await this.latestMatch(bufferId);

    let sourceEvents = existing?.sourceEvents
      ? [...existing.sourceEvents]
      : [];

    for (const clause of matchingClauses) {
      const duplicate = sourceEvents.some(
        (source) =>
          source.clauseId === clause.id &&
          sameEventIdentity(source, event),
      );
      if (!duplicate) {
        sourceEvents.push(asSourceEvent(clause.id, event));
      }
    }

    sourceEvents.sort(sourceEventOrder);

    const previousMaxObserved = existing?.patternState
      ?.maxObservedOccurredAt
      ? Date.parse(existing.patternState.maxObservedOccurredAt)
      : Number.NEGATIVE_INFINITY;
    const maxObserved = Math.max(
      previousMaxObserved,
      Date.parse(event.occurredAt),
      ...sourceEvents
        .map((source) => Date.parse(source.occurredAt))
        .filter(Number.isFinite),
    );
    const allowedLatenessMs =
      definition.eventTime?.allowedLatenessMs ?? 0;
    const watermarkMs = maxObserved - allowedLatenessMs;
    const retentionFloor = watermarkMs - definition.withinMs;
    sourceEvents = sourceEvents.filter(
      (source) => Date.parse(source.occurredAt) >= retentionFloor,
    );

    const bufferedPhysicalEvents = new Set(
      sourceEvents.map(patternPhysicalIdentity),
    ).size;

    if (
      bufferedPhysicalEvents > pattern.execution.maxBufferedEvents
    ) {
      await this.store.appendAudit({
        auditId: `audit_${(
          await sha256Hex(
            `${definition.triggerId}:${definition.version}:pattern_buffer_overflow:${key ?? '-'}:${nowIso}`,
          )
        ).slice(0, 24)}`,
        traceId: event.traceId,
        timestamp: nowIso,
        kind: 'event.buffer_overflow',
        entityType: 'trigger',
        entityId: definition.triggerId,
        details: {
          triggerVersion: definition.version,
          patternVersion: '2',
          correlationKey: key,
          bufferedEvents: bufferedPhysicalEvents,
          maxBufferedEvents:
            pattern.execution.maxBufferedEvents,
        },
      });
      const error = new Error(
        `Pattern v2 buffer exceeded maxBufferedEvents=${pattern.execution.maxBufferedEvents}`,
      );
      (error as Error & { code?: string }).code =
        'PATTERN_V2_BUFFER_LIMIT_EXCEEDED';
      throw error;
    }

    if (
      Date.parse(event.occurredAt) < retentionFloor &&
      !existing?.sourceEvents.some(
        (source) => sameEventIdentity(source, event),
      )
    ) {
      await this.store.appendAudit({
        auditId: `audit_${(
          await sha256Hex(
            `${definition.triggerId}:${definition.version}:pattern_late_event_dropped:${event.sourceEventId}:${nowIso}`,
          )
        ).slice(0, 24)}`,
        traceId: event.traceId,
        timestamp: nowIso,
        kind: 'event.late_dropped',
        entityType: 'trigger',
        entityId: definition.triggerId,
        details: {
          triggerVersion: definition.version,
          patternVersion: '2',
          sourceEventId: event.sourceEventId,
          occurredAt: event.occurredAt,
          watermarkAt: new Date(watermarkMs).toISOString(),
          retentionFloor: new Date(retentionFloor).toISOString(),
        },
      });
      return [{
        triggerId: definition.triggerId,
        match: existing ?? null,
        matched: false,
        fired: false,
      }];
    }

    const openedAt = sourceEvents[0]?.occurredAt ?? event.occurredAt;
    const buffer = TriggerMatchRecordSchema.parse({
      protocolVersion: COMPOSITE_TRIGGER_PROTOCOL_VERSION,
      schemaVersion: COMPOSITE_TRIGGER_SCHEMA_VERSION,
      matchId: bufferId,
      triggerId: definition.triggerId,
      triggerVersion: definition.version,
      status: 'partial',
      correlationKey: key,
      openedAt,
      expiresAt: new Date(
        Date.parse(openedAt) + definition.withinMs,
      ).toISOString(),
      updatedAt: nowIso,
      sourceEvents,
      correlationDecision: null,
      patternState: {
        version: '2',
        role: 'buffer',
        maxObservedOccurredAt: new Date(maxObserved).toISOString(),
        semanticDecisions: [],
      },
      firedWakeId: null,
      derivedEventIds: [],
    });

    await this.store.appendTriggerMatch(buffer);
    return this.evaluatePatternV2Buffer(definition, buffer, now);
  }

  private async evaluatePatternV2Buffer(
    definition: CompositeTriggerDefinition,
    buffer: TriggerMatchRecord,
    evaluationNow: Date,
  ): Promise<CompositeIngestResult[]> {
    const pattern = definition.patternV2;
    if (!pattern) return [];

    const nowIso = evaluationNow.toISOString();
    const evaluation = await evaluatePatternV2({
      definition: pattern,
      events: buffer.sourceEvents,
      evaluator: this.evaluator,
      now: evaluationNow,
      allowedLatenessMs:
        definition.eventTime?.allowedLatenessMs ?? 0,
    });

    for (const semantic of evaluation.semanticTrace) {
      await this.support.auditMatch(buffer, 'trigger.correlation', {
        patternVersion: '2',
        semanticNodeId: semantic.nodeId,
        candidateSignature: semantic.candidateSignature,
        evaluator: semantic.decision.evaluator,
        outcome: semantic.decision.outcome,
        probability: semantic.decision.probability,
        matched: semantic.decision.matched,
        shouldEscalate: semantic.decision.shouldEscalate,
        inputFields: semantic.decision.condition.input,
        ...(semantic.decision.metadata
          ? { providerEvidence: semantic.decision.metadata }
          : {}),
      });
    }

    await this.support.cancelDeadlinesForMatch(buffer.matchId);
    if (evaluation.pending.length) {
      const deadlines = evaluation.pending
        .filter((candidate) => candidate.pendingUntil)
        .map((candidate) => ({
          conditionId: `pattern-v2:${patternV2CandidateSignature(candidate)}`,
          dueAt: candidate.pendingUntil!,
        }));
      await this.support.scheduleDeadlines(
        definition,
        buffer,
        deadlines,
      );
    }

    const previouslyEmitted = new Set(
      (await this.store
        .listTriggerMatches(definition.triggerId))
        .filter((record) =>
          record.triggerVersion === definition.version &&
          record.patternState?.version === '2' &&
          record.patternState.role === 'match' &&
          record.patternState.signature
        )
        .map((record) => record.patternState!.signature!),
    );

    const fresh = evaluation.matches
      .map((candidate, rank) => ({ candidate, rank }))
      .filter(({ candidate }) =>
        candidate.events.length > 0 &&
        !previouslyEmitted.has(patternV2CandidateSignature(candidate))
      )
      .sort((left, right) =>
        left.candidate.startIndex - right.candidate.startIndex ||
        left.rank - right.rank
      )
      .map(({ candidate }) => candidate);

    const selected: PatternV2Candidate[] = [];
    const occupied = new Set<string>();

    let selectionLimit = pattern.selection.maxMatchesPerEvent;
    const hasEffect = Boolean(definition.target || definition.derivedEvent);
    if (hasEffect) {
      const triggerState = this.store.getTriggerState
        ? await this.store.getTriggerState(
          definition.triggerId,
          definition.version,
        )
        : null;
      const lifecycle = definition.lifecycle ?? {};

      if (lifecycle.oneShot || lifecycle.completeOnGoal) {
        selectionLimit = Math.min(selectionLimit, 1);
      }
      if (lifecycle.maxFirings !== undefined) {
        selectionLimit = Math.min(
          selectionLimit,
          Math.max(
            0,
            lifecycle.maxFirings - (triggerState?.fireCount ?? 0),
          ),
        );
      }
      if ((lifecycle.cooldownMs ?? 0) > 0) {
        selectionLimit = Math.min(selectionLimit, 1);
      }
    }
    const indexed = [...buffer.sourceEvents].sort(sourceEventOrder);
    const indexByIdentity = new Map(
      indexed.map((source, index) => [
        patternPhysicalIdentity(source),
        index,
      ]),
    );

    let skipPastLastThrough = -1;
    let skipBefore = -1;
    const skipStarts = new Set<number>();

    const bindingBoundary = (
      candidate: PatternV2Candidate,
      ref: string,
      edge: 'first' | 'last',
    ) => {
      const events = [...(candidate.bindings[ref] ?? [])]
        .sort(sourceEventOrder);
      const event = edge === 'first' ? events[0] : events.at(-1);
      if (!event) return null;
      return indexByIdentity.get(patternPhysicalIdentity(event)) ?? null;
    };

    for (const candidate of fresh) {
      if (selected.length >= selectionLimit) break;
      if (candidate.startIndex <= skipPastLastThrough) continue;
      if (candidate.startIndex < skipBefore) continue;
      if (skipStarts.has(candidate.startIndex)) continue;

      const identities = candidate.events.map(patternPhysicalIdentity);
      if (
        pattern.selection.overlap === 'disallow' &&
        identities.some((identity) => occupied.has(identity))
      ) {
        continue;
      }

      selected.push(candidate);
      identities.forEach((identity) => occupied.add(identity));

      const afterMatch = pattern.selection.afterMatch;
      if (afterMatch === 'skipPastLast') {
        skipPastLastThrough = Math.max(
          skipPastLastThrough,
          candidate.endIndex,
        );
      } else if (afterMatch === 'skipToNext') {
        skipStarts.add(candidate.startIndex);
      } else if (typeof afterMatch === 'object') {
        const boundary = bindingBoundary(
          candidate,
          afterMatch.ref,
          afterMatch.kind === 'skipToFirst' ? 'first' : 'last',
        );
        if (boundary !== null) {
          skipBefore = Math.max(skipBefore, boundary);
        }
      }
    }

    const results: CompositeIngestResult[] = [];
    for (const candidate of selected) {
      const signature = patternV2CandidateSignature(candidate);
      const matchId = `tm_${(
        await sha256Hex([
          definition.triggerId,
          definition.version,
          buffer.correlationKey ?? '-',
          signature,
          'pattern-v2-match',
        ].join(':'))
      ).slice(0, 24)}`;
      const openedAt =
        candidate.events[0]?.occurredAt ?? buffer.openedAt;
      const semanticDecisions = candidate.semanticDecisions.map((item) =>
        this.patternDecisionRecord(item, nowIso)
      );
      const lastSemantic =
        semanticDecisions.at(-1)?.decision ?? null;

      const matched = TriggerMatchRecordSchema.parse({
        protocolVersion: COMPOSITE_TRIGGER_PROTOCOL_VERSION,
        schemaVersion: COMPOSITE_TRIGGER_SCHEMA_VERSION,
        matchId,
        triggerId: definition.triggerId,
        triggerVersion: definition.version,
        status: 'matched',
        correlationKey: buffer.correlationKey,
        openedAt,
        expiresAt: new Date(
          Date.parse(openedAt) + definition.withinMs,
        ).toISOString(),
        updatedAt: nowIso,
        sourceEvents: candidate.events,
        correlationDecision: lastSemantic,
        patternState: {
          version: '2',
          role: 'match',
          signature,
          semanticDecisions,
        },
        firedWakeId: null,
        derivedEventIds: [],
      });

      await this.store.appendTriggerMatch(matched);
      await this.support.auditMatch(matched, 'trigger.matched', {
        patternVersion: '2',
        signature,
        semanticEvaluations: evaluation.semanticEvaluations,
        truncated: evaluation.truncated,
        sourceEventIds: matched.sourceEvents.map(
          (source) => source.sourceEventId,
        ),
      });

      results.push({
        triggerId: definition.triggerId,
        match: matched,
        matched: true,
        fired: false,
      });
    }

    if (selected.length) {
      const selectedIndexes = selected.flatMap((candidate) => [
        candidate.startIndex,
        candidate.endIndex,
      ]).filter((index) => index >= 0);
      const firstStart = selectedIndexes.length
        ? Math.min(...selected.map((candidate) => candidate.startIndex))
        : -1;
      const lastEnd = selectedIndexes.length
        ? Math.max(...selected.map((candidate) => candidate.endIndex))
        : -1;

      let retained = [...buffer.sourceEvents];

      const shouldDropByIndex = (index: number) => {
        const afterMatch = pattern.selection.afterMatch;
        if (afterMatch === 'skipPastLast') {
          return index <= lastEnd;
        }
        if (afterMatch === 'skipToNext') {
          return index <= firstStart;
        }
        if (typeof afterMatch === 'object') {
          const boundaries = selected
            .map((candidate) =>
              bindingBoundary(
                candidate,
                afterMatch.ref,
                afterMatch.kind === 'skipToFirst' ? 'first' : 'last',
              )
            )
            .filter((value): value is number => value !== null);
          if (!boundaries.length) return false;
          return index < Math.max(...boundaries);
        }
        return false;
      };

      const consumed =
        pattern.selection.overlap === 'disallow'
          ? new Set(
              selected
                .flatMap((candidate) => candidate.events)
                .map(patternPhysicalIdentity),
            )
          : new Set<string>();

      retained = indexed.filter((source, index) =>
        !shouldDropByIndex(index) &&
        !consumed.has(patternPhysicalIdentity(source))
      );

      const openedAt =
        retained[0]?.occurredAt ?? evaluationNow.toISOString();
      const updatedBuffer = TriggerMatchRecordSchema.parse({
        ...buffer,
        openedAt,
        expiresAt: new Date(
          Date.parse(openedAt) + definition.withinMs,
        ).toISOString(),
        updatedAt: nowIso,
        sourceEvents: retained,
      });
      await this.store.appendTriggerMatch(updatedBuffer);
    }

    if (!results.length) {
      await this.support.auditMatch(buffer, 'trigger.partial', {
        reason: 'pattern_v2_wait',
        patternVersion: '2',
        pendingCandidates: evaluation.pending.length,
        semanticEvaluations: evaluation.semanticEvaluations,
        truncated: evaluation.truncated,
      });
      return [{
        triggerId: definition.triggerId,
        match: buffer,
        matched: false,
        fired: false,
      }];
    }

    return results;
  }

  private async applyEvent(
    definition: CompositeTriggerDefinition,
    clause: TriggerClause,
    event: CorrelatableEvent,
  ): Promise<CompositeIngestResult> {
    const nowIso = this.now().toISOString();
    const eventTime = Date.parse(event.occurredAt);
    const key = deterministicKeyForClause(definition, clause.id, event);

    const relatedMatches = this.store
      .listTriggerMatches(definition.triggerId)
      .filter((record) =>
        record.triggerVersion === definition.version &&
        matchesCorrelationKey(record, key),
      );

    const activeMatches = relatedMatches.filter(
      (record) =>
        record.status === 'partial' || record.status === 'matched',
    );

    const alreadyMatched = activeMatches
      .filter((record) => record.status === 'matched')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];

    if (alreadyMatched) {
      return {
        triggerId: definition.triggerId,
        match: alreadyMatched,
        matched: true,
        fired: false,
      };
    }

    const partials = activeMatches.filter(
      (record) => record.status === 'partial',
    );

    const observedEventTimes = relatedMatches.flatMap((record) =>
      record.sourceEvents.map((source) => Date.parse(source.occurredAt))
    );
    const maxObservedEventTime = Math.max(
      eventTime,
      ...observedEventTimes.filter(Number.isFinite),
    );
    const allowedLatenessMs =
      definition.eventTime?.allowedLatenessMs ?? 0;
    const watermarkMs = maxObservedEventTime - allowedLatenessMs;

    // The watermark is the point before which new standalone windows are too
    // late to open. Existing partials are retained until their event-time
    // expiry falls strictly behind it, allowing a late event to complete a
    // still-valid in-window pattern.
    const staleIds = new Set<string>();
    for (const candidate of partials) {
      if (Date.parse(candidate.expiresAt) >= watermarkMs) continue;
      staleIds.add(candidate.matchId);
      const expired = TriggerMatchRecordSchema.parse({
        ...candidate,
        status: 'expired',
        updatedAt: nowIso,
      });
      await this.store.appendTriggerMatch(expired);
      await this.support.cancelDeadlinesForMatch(expired.matchId);
      await this.support.auditMatch(expired, 'trigger.expired', {
        reason: 'event_time_watermark_advanced',
        watermarkAt: new Date(watermarkMs).toISOString(),
        allowedLatenessMs,
        incomingSourceEventId: event.sourceEventId,
        incomingOccurredAt: event.occurredAt,
      });
    }

    const accumulatesOccurrences = clauseAccumulatesOccurrences(
      definition,
      clause.id,
    );
    const compatible = partials
      .filter((record) => !staleIds.has(record.matchId))
      .map((record) => ({
        record,
        window: prospectiveEventWindow(record, event, definition.withinMs),
        hasClause: record.sourceEvents.some(
          (source) => source.clauseId === clause.id,
        ),
      }))
      .filter(({ window }) => window.fits)
      .sort((a, b) =>
        (
          accumulatesOccurrences
            ? 0
            : Number(a.hasClause) - Number(b.hasClause)
        ) ||
        a.window.spanMs - b.window.spanMs ||
        Date.parse(b.record.updatedAt) - Date.parse(a.record.updatedAt)
      );

    let record = compatible[0]?.record;
    if (
      record &&
      !accumulatesOccurrences &&
      compatible[0]?.hasClause
    ) {
      // Repeated non-aggregating occurrences represent alternate paths through
      // the same partial match. Branch the candidate so the new occurrence can
      // advance the expression without destroying the pre-existing window.
      record = await this.branchMatch(definition, record, event);
    }

    if (!record && eventTime < watermarkMs) {
      await this.store.appendAudit({
        auditId: `audit_${(
          await sha256Hex(
            `${definition.triggerId}:${definition.version}:late_event_dropped:${event.sourceEventId}:${nowIso}`,
          )
        ).slice(0, 24)}`,
        traceId: event.traceId,
        timestamp: nowIso,
        kind: 'event.late_dropped',
        entityType: 'trigger',
        entityId: definition.triggerId,
        details: {
          triggerVersion: definition.version,
          sourceEventId: event.sourceEventId,
          occurredAt: event.occurredAt,
          receivedAt: event.receivedAt ?? null,
          watermarkAt: new Date(watermarkMs).toISOString(),
          allowedLatenessMs,
        },
      });
      return {
        triggerId: definition.triggerId,
        match: null,
        matched: false,
        fired: false,
      };
    }

    record ??= await this.newMatch(definition, key, event);

    const duplicate = record.sourceEvents.some(
      (candidate) => sameEventIdentity(candidate, event),
    );

    if (!duplicate) {
      const window = prospectiveEventWindow(
        record,
        event,
        definition.withinMs,
      );
      if (!window.fits) {
        // This can only happen for a newly-created incompatible candidate race.
        // Keep the existing partial intact and seed a fresh event-time window.
        record = await this.newMatch(definition, key, event);
      }
      const selectedWindow = prospectiveEventWindow(
        record,
        event,
        definition.withinMs,
      );
      record = TriggerMatchRecordSchema.parse({
        ...record,
        correlationKey: record.correlationKey ?? key,
        openedAt: selectedWindow.openedAt,
        expiresAt: selectedWindow.expiresAt,
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
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt ?? null,
        eventTimeWindow: {
          openedAt: record.openedAt,
          expiresAt: record.expiresAt,
        },
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

  private async branchMatch(
    definition: CompositeTriggerDefinition,
    source: TriggerMatchRecord,
    event: CorrelatableEvent,
  ): Promise<TriggerMatchRecord> {
    const matchId = `tm_${(
      await sha256Hex(
        [
          definition.triggerId,
          definition.version,
          source.matchId,
          event.sourceEventId,
          'branch',
        ].join(':'),
      )
    ).slice(0, 24)}`;

    return TriggerMatchRecordSchema.parse({
      ...source,
      matchId,
      status: 'partial',
      updatedAt: this.now().toISOString(),
      correlationDecision: null,
      firedWakeId: null,
      derivedEventIds: [],
    });
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

  private async latestMatch(
    matchId: string,
  ): Promise<TriggerMatchRecord | null> {
    return (await this.store.listTriggerMatches())
      .filter((record) => record.matchId === matchId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
  }


}
