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
  type TriggerSourceEvent,
} from '../intelligenceProtocol/triggerSchemas.js';
import {
  evaluateTemporalConditions,
} from './temporal.js';

export interface CompositeTriggerStore {
  putTrigger(definition: CompositeTriggerDefinition): Promise<void>;
  listTriggers(): CompositeTriggerDefinition[];
  getTriggerState?(
    triggerId: string,
    version: string,
  ): {
    status: 'active' | 'paused' | 'completed' | 'expired' | 'deleted';
    owner?: unknown;
    connectionIds?: string[];
    fireCount?: number;
    lastFiredAt?: string | null;
    revision?: number;
  } | null;
  setTriggerState?(
    triggerId: string,
    version: string,
    status: 'active' | 'paused' | 'completed' | 'expired' | 'deleted',
    actor?: unknown,
    metadata?: Record<string, unknown>,
  ): Promise<unknown>;
  appendTriggerMatch(record: TriggerMatchRecord): Promise<void>;
  listTriggerMatches(triggerId?: string): TriggerMatchRecord[];
  getTemporalDeadline?(deadlineId: string): {
    deadlineId: string;
    triggerId: string;
    triggerVersion: string;
    matchId: string;
    conditionId: string;
    dueAt: string;
    status: 'pending' | 'cancelled' | 'fired';
  } | null;
  listTemporalDeadlines?(filter?: {
    triggerId?: string;
    matchId?: string;
    status?: string;
  }): Array<{
    deadlineId: string;
    triggerId: string;
    triggerVersion: string;
    matchId: string;
    conditionId: string;
    dueAt: string;
    status: string;
  }>;
  putTemporalDeadline?(input: {
    deadlineId: string;
    triggerId: string;
    triggerVersion: string;
    matchId: string;
    conditionId: string;
    dueAt: string;
    status: 'pending' | 'cancelled' | 'fired';
  }): Promise<unknown>;
  setTemporalDeadlineStatus?(
    deadlineId: string,
    status: 'pending' | 'cancelled' | 'fired',
  ): Promise<unknown>;
}

export interface CompositeTriggerAudit {
  appendAudit(input: {
    auditId: string;
    traceId: string;
    timestamp: string;
    kind: string;
    entityType: 'trigger_match' | 'trigger';
    entityId: string;
    details?: Record<string, unknown>;
  }): Promise<unknown>;
}

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

function scalarKey(value: unknown): string | null {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) return String(value);
  return null;
}

function predicateMatches(
  event: CorrelatableEvent,
  predicate: TriggerClause['where'][number],
): boolean {
  const value = getByPath(event.data, predicate.path);

  switch (predicate.op) {
    case 'eq':
      return value === predicate.value;
    case 'neq':
      return value !== predicate.value;
    case 'contains':
      if (typeof value === 'string') return value.includes(String(predicate.value));
      if (Array.isArray(value)) return value.includes(predicate.value);
      return false;
    case 'in':
      return predicate.value.includes(value as string | number | boolean);
    case 'exists':
      return predicate.value ? value !== undefined : value === undefined;
  }
}

function clauseMatches(
  clause: TriggerClause,
  event: CorrelatableEvent,
): boolean {
  const contractVersion = getByPath(
    event.data,
    '_derived.contractVersion',
  );
  return (
    clause.event === event.name &&
    (!clause.serverId || clause.serverId === event.serverId) &&
    (
      !clause.contractVersion ||
      String(contractVersion ?? '') === String(clause.contractVersion)
    ) &&
    clause.where.every((predicate) => predicateMatches(event, predicate))
  );
}

function asSourceEvent(
  clauseId: string,
  event: CorrelatableEvent,
): TriggerSourceEvent {
  return {
    clauseId,
    traceId: event.traceId,
    sourceEventId: event.sourceEventId,
    eventName: event.name,
    occurredAt: event.occurredAt,
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.serverId ? { serverId: event.serverId } : {}),
    ...(event.payloadHash ? { payloadHash: event.payloadHash } : {}),
    data: event.data,
  };
}

function clauseEvents(
  record: TriggerMatchRecord,
  ref: string,
): TriggerSourceEvent[] {
  return record.sourceEvents
    .filter((event) => event.clauseId === ref)
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}

function expressionSatisfied(
  definition: CompositeTriggerDefinition,
  record: TriggerMatchRecord,
): boolean {
  const expression = definition.expression;

  if (expression.kind === 'allOf') {
    return expression.refs.every((ref) => clauseEvents(record, ref).length > 0);
  }

  if (expression.kind === 'anyOf') {
    return expression.refs.some((ref) => clauseEvents(record, ref).length > 0);
  }

  if (expression.kind === 'count') {
    return clauseEvents(record, expression.ref).length >= expression.atLeast;
  }

  let previous = Number.NEGATIVE_INFINITY;
  for (const ref of expression.refs) {
    const candidate = clauseEvents(record, ref)
      .find((event) => Date.parse(event.occurredAt) > previous);
    if (!candidate) return false;
    previous = Date.parse(candidate.occurredAt);
  }
  return true;
}

function semanticSource(record: TriggerMatchRecord): Record<string, unknown> {
  const source: Record<string, unknown> = {};
  for (const event of record.sourceEvents) {
    source[event.clauseId] = event.data;
  }
  return source;
}

function deterministicKeyForClause(
  definition: CompositeTriggerDefinition,
  clauseId: string,
  event: CorrelatableEvent,
): string | null {
  const deterministic = definition.correlation?.deterministic;
  if (!deterministic) return null;

  const field = deterministic.fields.find((item) => item.ref === clauseId);
  if (!field) return null;
  return scalarKey(getByPath(event.data, field.path));
}

function sameEventIdentity(
  source: Pick<TriggerSourceEvent, 'sourceEventId' | 'serverId'>,
  event: Pick<CorrelatableEvent, 'sourceEventId' | 'serverId'>,
): boolean {
  return (
    source.sourceEventId === event.sourceEventId &&
    (source.serverId ?? null) === (event.serverId ?? null)
  );
}

function matchesCorrelationKey(
  record: TriggerMatchRecord,
  key: string | null,
): boolean {
  if (record.correlationKey === null || key === null) return true;
  return record.correlationKey === key;
}


const DERIVED_SERVER_ID = 'event-intelligence:derived';

function eventNode(eventName: string, serverId?: string): string {
  return `${serverId || DERIVED_SERVER_ID}::${eventName}`;
}

function assertNoDerivedEventCycle(
  existing: CompositeTriggerDefinition[],
  candidate: CompositeTriggerDefinition,
  getState?: (
    triggerId: string,
    version: string,
  ) => { status: string } | null,
): void {
  const definitions = [
    ...existing.filter((definition) => {
      const state = getState?.(definition.triggerId, definition.version);
      return !state || state.status === 'active' || state.status === 'paused';
    }),
    candidate,
  ].filter((definition) => definition.derivedEvent);

  const graph = new Map<string, Set<string>>();
  for (const definition of definitions) {
    const output = eventNode(
      definition.derivedEvent!.name,
      DERIVED_SERVER_ID,
    );
    for (const clause of definition.clauses) {
      const input = eventNode(clause.event, clause.serverId);
      const edges = graph.get(input) ?? new Set<string>();
      edges.add(output);
      graph.set(input, edges);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const dfs = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) {
      if (dfs(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  for (const node of graph.keys()) {
    if (dfs(node)) {
      const error = new Error(
        `Derived event graph contains a cycle involving ${node}`,
      ) as Error & { code?: string };
      error.code = 'TRIGGER_DERIVED_EVENT_CYCLE';
      throw error;
    }
  }
}

export class CompositeTriggerEngine {
  constructor(
    private readonly store: CompositeTriggerStore & CompositeTriggerAudit,
    private readonly evaluator: SemanticEvaluator | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
      if (!(await this.lifecycleAllows(definition, triggerState, this.now()))) {
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
    await this.cancelDeadlinesForMatch(matchId);
    await this.audit(fired, 'trigger.fired', { wakeId });

    await this.advanceLifecycleAfterEffect(
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
    await this.cancelDeadlinesForMatch(matchId);
    await this.audit(emitted, 'trigger.emitted', {
      derivedEventId,
    });
    await this.advanceLifecycleAfterEffect(
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
    if (!(await this.lifecycleAllows(definition, triggerState, this.now()))) {
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
      await this.cancelDeadlinesForMatch(expired.matchId);
      await this.audit(expired, 'trigger.expired', {
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
      await this.cancelDeadlinesForMatch(expired.matchId);
      await this.audit(expired, 'trigger.expired', {
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
      await this.audit(record, 'trigger.partial', {
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
      await this.cancelDeadlinesForMatch(expired.matchId);
      await this.audit(expired, 'trigger.expired', {
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
      await this.scheduleDeadlines(
        definition,
        record,
        temporal.pendingDeadlines,
      );
      await this.audit(record, 'trigger.partial', {
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

    await this.cancelDeadlinesForMatch(record.matchId);

    if (definition.correlation?.semantic) {
      if (!this.evaluator) {
        await this.store.appendTriggerMatch(record);
        await this.audit(record, 'trigger.partial', {
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
      await this.audit(record, 'trigger.correlation', {
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
    await this.audit(matched, 'trigger.matched', {
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

  private async scheduleDeadlines(
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

  private async cancelDeadlinesForMatch(matchId: string): Promise<void> {
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

  private async advanceLifecycleAfterEffect(
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

  private async lifecycleAllows(
    definition: CompositeTriggerDefinition,
    state: {
      status: 'active' | 'paused' | 'completed' | 'expired' | 'deleted';
      owner?: unknown;
      connectionIds?: string[];
      fireCount?: number;
      lastFiredAt?: string | null;
    } | null,
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

  private async auditTriggerLifecycle(
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

  private async audit(
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
