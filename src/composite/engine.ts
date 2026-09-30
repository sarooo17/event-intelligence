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
  asSourceEvent,
  clauseMatches,
  sameEventIdentity,
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
        ...await this.applyPattern(
          definition,
          matchingClauses,
          event,
        ),
      );
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
      match.patternState?.version === '2' &&
      match.patternState.role === 'buffer'
    ) {
      return this.evaluatePatternBuffer(
        definition,
        match,
        new Date(event.occurredAt),
      );
    }

    return [];
  }

  private patternPartitionKey(
    definition: CompositeTriggerDefinition,
    matchingClauses: TriggerClause[],
    event: CorrelatableEvent,
  ): string | null {
    const dimensions = definition.pattern?.partitionBy ?? [];
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

  private async applyPattern(
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
      return this.applyPatternWithPartition(
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
      return await this.applyPatternWithPartition(
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

  private async applyPatternWithPartition(
    definition: CompositeTriggerDefinition,
    matchingClauses: TriggerClause[],
    event: CorrelatableEvent,
    key: string | null,
  ): Promise<CompositeIngestResult[]> {
    const pattern = definition.pattern;
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
          partitionKey: key,
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
      partitionKey: key,
      openedAt,
      expiresAt: new Date(
        Date.parse(openedAt) + definition.withinMs,
      ).toISOString(),
      updatedAt: nowIso,
      sourceEvents,
      semanticDecision: null,
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
    return this.evaluatePatternBuffer(definition, buffer, now);
  }

  private candidateFitsTriggerWindow(
    candidate: PatternV2Candidate,
    withinMs: number,
  ): boolean {
    if (candidate.events.length < 2) return true;
    const times = candidate.events
      .map((event) => Date.parse(event.occurredAt))
      .filter(Number.isFinite);
    if (times.length < 2) return true;
    return Math.max(...times) - Math.min(...times) <= withinMs;
  }

  private async evaluatePatternBuffer(
    definition: CompositeTriggerDefinition,
    buffer: TriggerMatchRecord,
    evaluationNow: Date,
  ): Promise<CompositeIngestResult[]> {
    const pattern = definition.pattern;
    if (!pattern) return [];

    const nowIso = evaluationNow.toISOString();
    const semanticCache =
      typeof (this.store as any).getSemanticDecisionCache === 'function' &&
      typeof (this.store as any).putSemanticDecisionCache === 'function'
        ? {
          get: (key: string) =>
            (this.store as any).getSemanticDecisionCache(key),
          set: (key: string, decision: unknown) =>
            (this.store as any).putSemanticDecisionCache(
              key,
              decision,
            ),
        }
        : null;

    const reachedDeadlines =
      this.store.listTemporalDeadlines
        ? (await this.store.listTemporalDeadlines({
            matchId: buffer.matchId,
            status: 'pending',
          }))
            .filter((deadline) =>
              Date.parse(deadline.dueAt) <= evaluationNow.getTime()
            )
        : [];

    const evaluation = await evaluatePatternV2({
      definition: pattern,
      events: buffer.sourceEvents,
      evaluator: this.evaluator,
      now: evaluationNow,
      allowedLatenessMs:
        definition.eventTime?.allowedLatenessMs ?? 0,
      semanticCache,
      semanticCacheNamespace:
        `${definition.triggerId}@${definition.version}`,
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
        semanticCacheHits: evaluation.semanticCacheHits,
        semanticCacheMisses: evaluation.semanticCacheMisses,
        inputFields: semantic.decision.condition.input,
        ...(semantic.decision.metadata
          ? { providerEvidence: semantic.decision.metadata }
          : {}),
      });
    }

    await this.support.cancelDeadlinesForMatch(buffer.matchId);
    if (evaluation.pending.length) {
      const deadlines = evaluation.pending
        .filter((candidate) =>
          candidate.pendingUntil &&
          this.candidateFitsTriggerWindow(candidate, definition.withinMs)
        )
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
      .filter((candidate) =>
        this.candidateFitsTriggerWindow(candidate, definition.withinMs)
      )
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
          buffer.partitionKey ?? '-',
          signature,
          'pattern-v2-match',
        ].join(':'))
      ).slice(0, 24)}`;
      const openedAt =
        candidate.events[0]?.occurredAt ?? buffer.openedAt;
      const semanticDecisions = candidate.semanticDecisions.map((item) =>
        this.patternDecisionRecord(item, nowIso)
      );
      const sourceCompletionAt = candidate.events
        .map((item) => Date.parse(item.occurredAt))
        .filter(Number.isFinite)
        .sort((a, b) => b - a)[0] ?? evaluationNow.getTime();
      const deadlineConditionId = `pattern-v2:${signature}`;
      const deadlineCompletionAt = reachedDeadlines
        .filter((deadline) => deadline.conditionId === deadlineConditionId)
        .map((deadline) => Date.parse(deadline.dueAt))
        .filter(Number.isFinite)
        .sort((a, b) => b - a)[0];
      const completedAt = new Date(
        deadlineCompletionAt ?? sourceCompletionAt,
      ).toISOString();
      const lastSemantic =
        semanticDecisions.at(-1)?.decision ?? null;

      const matched = TriggerMatchRecordSchema.parse({
        protocolVersion: COMPOSITE_TRIGGER_PROTOCOL_VERSION,
        schemaVersion: COMPOSITE_TRIGGER_SCHEMA_VERSION,
        matchId,
        triggerId: definition.triggerId,
        triggerVersion: definition.version,
        status: 'matched',
        partitionKey: buffer.partitionKey,
        openedAt,
        expiresAt: new Date(
          Date.parse(openedAt) + definition.withinMs,
        ).toISOString(),
        updatedAt: nowIso,
        sourceEvents: candidate.events,
        semanticDecision: lastSemantic,
        patternState: {
          version: '2',
          role: 'match',
          signature,
          completedAt,
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

  private async latestMatch(
    matchId: string,
  ): Promise<TriggerMatchRecord | null> {
    return (await this.store.listTriggerMatches())
      .filter((record) => record.matchId === matchId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
  }


}
