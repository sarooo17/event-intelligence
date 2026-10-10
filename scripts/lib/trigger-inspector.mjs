import {
  CompositeTriggerEngine,
} from '../../dist/src/composite/engine.js';
import {
  parseCompositeTriggerDefinition,
  parseCorrelatableEvent,
  parseTriggerMatchRecord,
} from '../../dist/src/intelligenceProtocol/index.js';

function latest(records) {
  const rank = (record) => {
    if (record.status === 'fired') return 5;
    if (record.status === 'emitted') return 4;
    if (record.status === 'matched') return 3;
    if (record.status === 'partial' && record.patternState?.role === 'match') return 2;
    if (record.status === 'partial') return 1;
    return 0;
  };

  return [...records].sort(
    (a, b) =>
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
      rank(b) - rank(a),
  )[0] ?? null;
}

function sourceRef(event) {
  return {
    clauseId: event.clauseId,
    serverId: event.serverId ?? null,
    eventName: event.eventName,
    sourceEventId: event.sourceEventId,
    occurredAt: event.occurredAt,
    traceId: event.traceId,
    payloadHash: event.payloadHash ?? null,
    contractVersion:
      event.data?._derived?.contractVersion ?? null,
    schemaFingerprint:
      event.data?._derived?.schemaFingerprint ?? null,
  };
}

function clauseState(definition, match) {
  const seen = new Map();
  for (const event of match?.sourceEvents ?? []) {
    const current = seen.get(event.clauseId) ?? [];
    current.push(sourceRef(event));
    seen.set(event.clauseId, current);
  }

  return definition.clauses.map((clause) => {
    const evidence = seen.get(clause.id) ?? [];
    return {
      clauseId: clause.id,
      event: clause.event,
      serverId: clause.serverId ?? null,
      contractVersion: clause.contractVersion ?? null,
      status: evidence.length ? 'observed' : 'waiting',
      observedCount: evidence.length,
      evidence,
    };
  });
}

function explain({ state, match, wake }) {
  if (state.status === 'paused') {
    return {
      code: 'trigger_paused',
      summary: 'Trigger is paused and will not consume new events.',
    };
  }
  if (state.status === 'completed') {
    return {
      code: 'trigger_completed',
      summary: 'Trigger lifecycle is complete.',
    };
  }
  if (state.status === 'expired') {
    return {
      code: 'trigger_lifecycle_expired',
      summary: 'Trigger lifecycle has expired.',
    };
  }
  if (state.status === 'deleted') {
    return {
      code: 'trigger_deleted',
      summary: 'Trigger has been deleted.',
    };
  }

  if (!match) {
    return {
      code: 'waiting_for_pattern_evidence',
      summary: 'Waiting for evidence that can satisfy the Pattern AST.',
      patternVersion: '2',
    };
  }

  if (match.status === 'fired') {
    return {
      code: 'fired',
      summary: wake?.runtimeReceiptId
        ? `Fired and acknowledged by runtime receipt ${wake.runtimeReceiptId}.`
        : 'Fired; runtime acknowledgement is not present in the current wake record.',
    };
  }
  if (match.status === 'emitted') {
    return {
      code: 'derived_event_emitted',
      summary: match.derivedEventIds.length
        ? `Derived event emitted: ${match.derivedEventIds.join(', ')}.`
        : 'Derived event emitted.',
    };
  }
  if (match.status === 'matched') {
    return {
      code: 'matched_waiting_delivery',
      summary: 'The Pattern AST is satisfied; effect delivery is pending or not yet marked fired.',
    };
  }
  if (match.status === 'expired') {
    return {
      code: 'match_expired',
      summary: 'This Pattern match can no longer satisfy the trigger.',
    };
  }

  return {
    code: 'pattern_waiting',
    summary: 'Pattern AST has buffered evidence but no new complete match is currently eligible.',
    patternVersion: '2',
    bufferRole: match.patternState?.role ?? null,
    semanticDecisions: match.patternState?.semanticDecisions ?? [],
  };
}

export class TriggerInspector {
  constructor({
    store,
    now = () => new Date(),
    matchHistoryLimit = null,
  }) {
    if (matchHistoryLimit !== null &&
        (!Number.isInteger(matchHistoryLimit) ||
          matchHistoryLimit < 1 || matchHistoryLimit > 500)) {
      throw new RangeError('matchHistoryLimit must be an integer from 1 to 500');
    }
    this.store = store;
    this.now = now;
    this.matchHistoryLimit = matchHistoryLimit;
  }

  async inspect({
    triggerId,
    version,
    matchId,
  }) {
    const candidates = (await this.store.listTriggers())
      .filter((definition) => definition.triggerId === triggerId)
      .filter((definition) => !version || definition.version === version);

    if (!candidates.length) {
      const error = new Error(`Unknown trigger: ${triggerId}`);
      error.code = 'TRIGGER_NOT_FOUND';
      throw error;
    }

    const definition = version
      ? candidates[0]
      : [...candidates].sort((a, b) =>
          String(b.version).localeCompare(String(a.version), undefined, {
            numeric: true,
          })
        )[0];

    const state = await this.store.getTriggerState(
      definition.triggerId,
      definition.version,
    );

    const matches = (await this.store.listTriggerMatches(definition.triggerId))
      .filter((match) => match.triggerVersion === definition.version);
    const match = matchId
      ? matches.find((candidate) => candidate.matchId === matchId) ?? null
      : latest(matches);

    if (matchId && !match) {
      const error = new Error(`Unknown trigger match: ${matchId}`);
      error.code = 'TRIGGER_MATCH_NOT_FOUND';
      throw error;
    }

    const clauses = clauseState(definition, match);
    const deadlines = match && this.store.listTemporalDeadlines
      ? await this.store.listTemporalDeadlines({ matchId: match.matchId })
      : [];
    const pendingDeadlines = deadlines.filter(
      (deadline) => deadline.status === 'pending',
    );
    const nextEvaluationAt = pendingDeadlines
      .map((deadline) => deadline.dueAt)
      .sort()[0] ?? null;

    const wake = match?.firedWakeId
      ? await this.store.latestWake(match.firedWakeId)
      : null;

    const derivedOutputs = match
      ? (await this.store.listDerivedEvents?.({ matchId: match.matchId }) ?? [])
      : [];

    // Use the storage adapter's indexed recent-history query when the
    // caller explicitly requests a bounded window. For custom stores without
    // that optional optimization, retain the ordinary history path.
    let recentHistory = [];
    let historyTruncated = false;
    if (match && this.matchHistoryLimit !== null &&
        typeof this.store.getRecentTriggerMatchHistory === 'function') {
      const window = await this.store.getRecentTriggerMatchHistory(
        match.matchId,
        { limit: this.matchHistoryLimit },
      );
      if (!window || !Array.isArray(window.records) ||
          typeof window.hasMore !== 'boolean') {
        const error = new Error('Store returned invalid bounded history window');
        error.code = 'EVENT_INTELLIGENCE_HISTORY_WINDOW_INVALID';
        throw error;
      }
      recentHistory = window.records;
      historyTruncated = window.hasMore;
    } else {
      const rawHistory = match && this.store.listTriggerMatchHistory
        ? await this.store.listTriggerMatchHistory(match.matchId)
        : (match ? [match] : []);
      recentHistory = this.matchHistoryLimit === null
        ? rawHistory : rawHistory.slice(-this.matchHistoryLimit);
      historyTruncated = rawHistory.length > recentHistory.length;
    }
    const matchHistory = recentHistory.map((record) => ({
      status: record.status,
      updatedAt: record.updatedAt,
      firedWakeId: record.firedWakeId,
      derivedEventIds: record.derivedEventIds ?? [],
      sourceEventIds: record.sourceEvents.map(
        (event) => event.sourceEventId,
      ),
    }));

    return {
      trigger: {
        triggerId: definition.triggerId,
        version: definition.version,
        description: definition.description ?? null,
        continuation: definition.continuation ?? null,
        target: definition.target ?? null,
        derivedEvent: definition.derivedEvent ?? null,
        pattern: definition.pattern,
        lifecycle: definition.lifecycle ?? {},
      },
      lifecycle: state,
      match: match
        ? {
            matchId: match.matchId,
            status: match.status,
            partitionKey: match.partitionKey,
            openedAt: match.openedAt,
            expiresAt: match.expiresAt,
            updatedAt: match.updatedAt,
            patternState: match.patternState ?? null,
          }
        : null,
      clauses,
      evidenceSummary: {
        selectionBasis: matchId
          ? 'explicit_match'
          : match ? 'latest_match' : 'no_match',
        observedClauseIds: clauses.filter((clause) =>
          clause.status === 'observed'
        ).map((clause) => clause.clauseId),
        unobservedClauseIds: clauses.filter((clause) =>
          clause.status === 'waiting'
        ).map((clause) => clause.clauseId),
        pendingDeadlineCount: pendingDeadlines.length,
        nextEvaluationAt,
      },
      deadlines: deadlines.map((deadline) => ({
        deadlineId: deadline.deadlineId,
        conditionId: deadline.conditionId,
        dueAt: deadline.dueAt,
        status: deadline.status,
      })),
      nextEvaluationAt,
      wake: wake
        ? {
            wakeId: wake.wakeId,
            status: wake.status,
            runtimeReceiptId: wake.runtimeReceiptId ?? null,
            target: wake.target,
            createdAt: wake.createdAt,
          }
        : null,
      lineage: {
        evidence: match?.sourceEvents.map(sourceRef) ?? [],
        derivedOutputs: derivedOutputs.map((record) => ({
          eventId: record.event.sourceEventId,
          eventName: record.event.name,
          contractVersion:
            record.event.data?._derived?.contractVersion ?? null,
          schemaFingerprint:
            record.event.data?._derived?.schemaFingerprint ?? null,
          occurredAt: record.event.occurredAt,
          directParents: record.directParents,
          rootEvidence: record.rootEvidence,
        })),
        matchHistory,
        historyTruncated,
        historyLimit: this.matchHistoryLimit,
        patternState: match?.patternState ?? null,
      },
      why: explain({ state, match, wake }),
    };
  }
}

class SimulationStore {
  constructor() {
    this.triggers = [];
    this.matches = new Map();
    this.matchHistory = [];
    this.deadlines = new Map();
    this.audit = [];
    this.wakes = [];
    this.states = new Map();
  }

  async putTrigger(definitionInput) {
    const definition = parseCompositeTriggerDefinition(definitionInput);
    this.triggers.push(definition);
    return definition;
  }

  listTriggers() {
    return this.triggers;
  }

  getTriggerState(triggerId, version) {
    return this.states.get(`${triggerId}@${version}`) ?? {
      triggerId,
      version,
      status: 'active',
      updatedAt: null,
      actor: null,
      owner: null,
      connectionIds: [],
      fireCount: 0,
      lastFiredAt: null,
      revision: 0,
    };
  }

  async setTriggerState(triggerId, version, status, actor = null, metadata = {}) {
    const key = `${triggerId}@${version}`;
    const previous = this.getTriggerState(triggerId, version);
    const next = {
      ...previous,
      status,
      actor,
      updatedAt: new Date().toISOString(),
      owner: metadata.owner ?? previous.owner,
      connectionIds: metadata.connectionIds ?? previous.connectionIds,
      fireCount: metadata.fireCount ?? previous.fireCount,
      lastFiredAt:
        metadata.lastFiredAt !== undefined
          ? metadata.lastFiredAt
          : previous.lastFiredAt,
      revision: previous.revision + 1,
    };
    this.states.set(key, next);
    return next;
  }

  async appendTriggerMatch(recordInput) {
    const record = parseTriggerMatchRecord(recordInput);
    this.matches.set(record.matchId, record);
    this.matchHistory.push(record);
    return record;
  }

  listTriggerMatches(triggerId) {
    return [...this.matches.values()]
      .filter((record) => !triggerId || record.triggerId === triggerId);
  }

  listTriggerMatchHistory(matchId) {
    return this.matchHistory
      .filter((record) => !matchId || record.matchId === matchId);
  }

  async appendAudit(input) {
    const record = {
      ...input,
      sequence: this.audit.length,
    };
    this.audit.push(record);
    return record;
  }

  auditLength() {
    return this.audit.length;
  }

  async putTemporalDeadline(input) {
    const previous = this.deadlines.get(input.deadlineId);
    const record = {
      ...input,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.deadlines.set(record.deadlineId, record);
    return record;
  }

  getTemporalDeadline(deadlineId) {
    return this.deadlines.get(deadlineId) ?? null;
  }

  listTemporalDeadlines({ triggerId, matchId, status } = {}) {
    return [...this.deadlines.values()]
      .filter((deadline) => !triggerId || deadline.triggerId === triggerId)
      .filter((deadline) => !matchId || deadline.matchId === matchId)
      .filter((deadline) => !status || deadline.status === status);
  }

  listDueTemporalDeadlines(nowIso) {
    return this.listTemporalDeadlines({ status: 'pending' })
      .filter((deadline) =>
        Date.parse(deadline.dueAt) <= Date.parse(nowIso)
      )
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  }

  async setTemporalDeadlineStatus(deadlineId, status) {
    const previous = this.deadlines.get(deadlineId);
    if (!previous) return null;
    const next = {
      ...previous,
      status,
      updatedAt: new Date().toISOString(),
    };
    this.deadlines.set(deadlineId, next);
    return next;
  }

  latestWake(wakeId) {
    return [...this.wakes].reverse()
      .find((wake) => wake.wakeId === wakeId) ?? null;
  }

  async appendWake(wake) {
    this.wakes.push(wake);
    return wake;
  }
}

export async function simulateTrigger({
  definition: definitionInput,
  events,
  until,
  order = 'provided',
}) {
  const definition = parseCompositeTriggerDefinition(definitionInput);
  const normalized = (events ?? []).map(parseCorrelatableEvent);
  if (order === 'event_time') {
    normalized.sort(
      (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
    );
  } else if (order !== 'provided') {
    throw new Error('Simulation order must be provided or event_time');
  }

  let clock = normalized.length
    ? new Date(normalized[0].occurredAt)
    : new Date();
  const store = new SimulationStore();
  const engine = new CompositeTriggerEngine(
    store,
    null,
    () => clock,
  );
  await engine.register(definition);

  const steps = [];
  for (const event of normalized) {
    clock = new Date(
      Math.max(clock.getTime(), Date.parse(event.occurredAt)),
    );
    const results = await engine.ingest(event);
    steps.push({
      type: 'event',
      sourceEventId: event.sourceEventId,
      eventName: event.name,
      processingTime: clock.toISOString(),
      results: results.map((result) => ({
        triggerId: result.triggerId,
        matchId: result.match?.matchId ?? null,
        status: result.match?.status ?? null,
        matched: result.matched,
        fired: result.fired,
      })),
    });
  }

  const untilTime = until ? Date.parse(until) : null;
  if (until && !Number.isFinite(untilTime)) {
    throw new Error('Simulation until must be a valid ISO timestamp');
  }

  if (untilTime !== null) {
    while (true) {
      const due = store
        .listTemporalDeadlines({ status: 'pending' })
        .filter((deadline) => Date.parse(deadline.dueAt) <= untilTime)
        .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0];
      if (!due) break;

      clock = new Date(
        Math.max(clock.getTime(), Date.parse(due.dueAt)),
      );
      const timerEvent = {
        traceId: `simulation:${due.deadlineId}`,
        sourceEventId: `simulation:${due.deadlineId}`,
        name: 'event-intelligence.timer.reached',
        serverId: 'event-intelligence:timer',
        provider: 'event-intelligence',
        occurredAt: clock.toISOString(),
        data: {
          deadlineId: due.deadlineId,
          triggerId: due.triggerId,
          triggerVersion: due.triggerVersion,
          matchId: due.matchId,
          conditionId: due.conditionId,
          dueAt: due.dueAt,
        },
      };

      const results = await engine.ingest(timerEvent);
      await store.setTemporalDeadlineStatus(due.deadlineId, 'fired');
      steps.push({
        type: 'timer',
        deadlineId: due.deadlineId,
        conditionId: due.conditionId,
        processingTime: clock.toISOString(),
        results: results.map((result) => ({
          triggerId: result.triggerId,
          matchId: result.match?.matchId ?? null,
          status: result.match?.status ?? null,
          matched: result.matched,
          fired: result.fired,
        })),
      });
    }
    clock = new Date(Math.max(clock.getTime(), untilTime));
  }

  const inspector = new TriggerInspector({
    store,
    now: () => clock,
  });

  return {
    isolated: true,
    order,
    evaluatedUntil: clock.toISOString(),
    steps,
    inspection: await inspector.inspect({
      triggerId: definition.triggerId,
      version: definition.version,
    }),
    auditRecords: store.audit.length,
  };
}
