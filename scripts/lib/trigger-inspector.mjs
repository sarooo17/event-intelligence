import * as z from 'zod/v4';
import { isProxy } from 'node:util/types';
import { createCausalTimeline } from './causal-timeline.mjs';
import { classifyExplainReason } from './explain-reason-v2.mjs';
import { sha256Hex } from '../../dist/src/intelligenceProtocol/index.js';

import {
  CompositeTriggerEngine,
} from '../../dist/src/composite/engine.js';
import {
  parseCompositeTriggerDefinition,
  parseCorrelatableEvent,
  parseTriggerMatchRecord,
} from '../../dist/src/intelligenceProtocol/index.js';

// Apply the same offset-aware ISO boundary to direct library calls as to the
// MCP schema; Date.parse alone accepts host-timezone-dependent local dates.
const simulationTimestamp = z.iso.datetime({ offset: true });

function validHistoryProjection(record) {
  return Boolean(
    record && typeof record === 'object' && !Array.isArray(record) &&
    typeof record.status === 'string' && record.status.length > 0 &&
    typeof record.updatedAt === 'string' &&
    Number.isFinite(Date.parse(record.updatedAt)) &&
    Array.isArray(record.sourceEvents) &&
    record.sourceEvents.every((event) =>
      event && typeof event === 'object' &&
      typeof event.sourceEventId === 'string' &&
      event.sourceEventId.length > 0
    ) &&
    (record.derivedEventIds === undefined ||
      (Array.isArray(record.derivedEventIds) &&
        record.derivedEventIds.every((id) => typeof id === 'string')))
  );
}

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

// The untrusted event payload is NEVER an inspector output contract. Some
// older/host-provided stores may carry malformed _derived metadata (including
// nested objects or accessor properties). Project only canonical scalar
// provenance labels through own data descriptors; never serialize payload
// objects, getters, or arbitrary values as causal evidence.
function derivedMetadata(data) {
  // A proxy may execute arbitrary userland traps on descriptor reflection.
  // The Node intrinsic tests proxy identity without invoking those traps.
  if (!data || typeof data !== 'object' ||
      isProxy(data) || Array.isArray(data)) {
    return { contractVersion: null, schemaFingerprint: null };
  }
  const metadata = Object.getOwnPropertyDescriptor(data, '_derived')?.value;
  if (!metadata || typeof metadata !== 'object' ||
      isProxy(metadata) || Array.isArray(metadata)) {
    return { contractVersion: null, schemaFingerprint: null };
  }
  const version = Object.getOwnPropertyDescriptor(metadata, 'contractVersion')?.value;
  const hash = Object.getOwnPropertyDescriptor(metadata, 'schemaFingerprint')?.value;
  return {
    contractVersion: typeof version === 'string' &&
      version.length >= 1 && version.length <= 50 ? version : null,
    schemaFingerprint: typeof hash === 'string' &&
      /^[a-f0-9]{64}$/.test(hash) ? hash : null,
  };
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
    ...derivedMetadata(event.data),
  };
}

function clauseState(definition, match, evidenceRefLimit = null) {
  const seen = new Map();
  const counts = new Map();
  const selected = [];
  // Scan every persisted reference so that a bounded output does NOT
  // misclassify a later observed clause as missing. Project sourceRef()
  // only for the requested bounded number; no raw payload is returned.
  for (const event of match?.sourceEvents ?? []) {
    counts.set(event.clauseId, (counts.get(event.clauseId) ?? 0) + 1);
    if (evidenceRefLimit !== null && selected.length >= evidenceRefLimit) continue;
    const ref = sourceRef(event);
    selected.push(ref);
    const current = seen.get(event.clauseId) ?? [];
    current.push(ref);
    seen.set(event.clauseId, current);
  }

  return {
    selected,
    clauses: definition.clauses.map((clause) => {
      const evidence = seen.get(clause.id) ?? [];
      const observedCount = counts.get(clause.id) ?? 0;
      return {
        clauseId: clause.id,
        event: clause.event,
        serverId: clause.serverId ?? null,
        contractVersion: clause.contractVersion ?? null,
        status: observedCount ? 'observed' : 'waiting',
        observedCount,
        evidence,
      };
    }),
  };
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

// Versioned, payload-free classification based only on authoritative
// persisted trigger/match/wake/deadline records. These states do not infer
// that an upstream event was impossible or that a source is available.
function diagnosticState({ state, match, wake, clauses, pendingDeadlines, definition }) {
  const contract='ei.trigger-inspection.v1';
  const sourceCertainty='unverified';
  const emit=(kind, evidence='persisted_state')=>({
    contract,kind,evidence,sourceCertainty,
    missingClauseIds:clauses.filter(c=>c.status==='waiting')
      .map(c=>c.clauseId),
    pendingDeadlineCount:pendingDeadlines.length,
  });

  if (state.status==='paused' || state.status==='deleted') {
    return emit('inactive');
  }
  if (state.status==='expired' || state.status==='completed') {
    return emit('lifecycle_ended');
  }
  if (wake?.status==='dead_letter') return emit('wake_failed');
  if (match?.status==='fired') return emit('fired');
  if (match?.status==='emitted') return emit('derived_emitted');
  if (match?.status==='matched') return emit(definition.conditionOnly
    ? 'condition_satisfied' : 'effect_pending');
  if (match?.status==='expired') return emit('match_expired');
  if (pendingDeadlines.length>0) return emit('temporal_pending');
  if (!match) return emit('no_local_match');
  return emit('pattern_pending');
}

// Strict mode snapshots only inert JSON data. Never stringify a custom-store
// object directly: getters, proxies and toJSON hooks can execute code or
// return a different result on a second serialization by the host.
function safeInspectionJson(value, maxBytes) {
  const stack = new WeakSet();
  let visited = 0;
  const refuse = () => {
    const error = new Error('Strict inspection contains unsafe or oversized JSON evidence');
    error.code = 'EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED';
    throw error;
  };
  function snapshot(node, depth, inArray = false) {
    if (node === undefined) return inArray ? null : undefined;
    if (node === null || typeof node === 'boolean' ||
        typeof node === 'string') return node;
    if (typeof node === 'number') return Number.isFinite(node) ? node : null;
    if (typeof node !== 'object' || isProxy(node) || depth > 64 ||
        ++visited > 100000 || stack.has(node)) refuse();
    const isArray = Array.isArray(node);
    const proto = Object.getPrototypeOf(node);
    if (isArray ? proto !== Array.prototype :
        proto !== Object.prototype && proto !== null) refuse();
    if (Object.getOwnPropertySymbols(node).length) refuse();
    stack.add(node);
    const descriptors = Object.getOwnPropertyDescriptors(node);
    let result;
    if (isArray) {
      // A null-prototype intermediate array cannot inherit toJSON.
      result = [];
      Object.setPrototypeOf(result, null);
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length > 100000 ||
          Object.keys(descriptors).some(k =>
            k !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(k) ||
              Number(k) >= length))) refuse();
      for (let i = 0; i < length; i++) {
        const entry = descriptors[String(i)];
        if (entry && !Object.hasOwn(entry, 'value')) refuse();
        result[i] = entry ? snapshot(entry.value, depth + 1, true) : null;
      }
    } else {
      result = Object.create(null);
      for (const [key, entry] of Object.entries(descriptors)) {
        if (key === 'toJSON' || !Object.hasOwn(entry, 'value')) refuse();
        if (!entry.enumerable) continue;
        const child = snapshot(entry.value, depth + 1);
        if (child !== undefined) result[key] = child;
      }
    }
    stack.delete(node);
    return result;
  }
  const inert = snapshot(value, 0);
  // All objects have null prototypes and data-only descriptors here.
  const serialized = JSON.stringify(inert);
  if (typeof serialized !== 'string' ||
      Buffer.byteLength(serialized, 'utf8') > maxBytes) refuse();
  // Return *exactly* the JSON content that was budget-checked, with ordinary
  // consumer-friendly arrays/objects but no original provider hooks.
  return {bytes: Buffer.byteLength(serialized, 'utf8'),
    snapshot: JSON.parse(serialized)};
}
function strictByteBudget(value, maxBytes) {
  return safeInspectionJson(value, maxBytes).bytes;
}
function strictPageBudget(records, maxRowBytes, maxTotalBytes) {
  const safeRecords = [];
  let total = 0;
  for (const record of records) {
    const safe = safeInspectionJson(record, maxRowBytes);
    total += safe.bytes;
    if (total > maxTotalBytes) {
      const error = new Error('Strict inspection evidence page exceeds total byte budget');
      error.code = 'EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED';
      throw error;
    }
    safeRecords.push(safe.snapshot);
  }
  return safeRecords;
}

export class TriggerInspector {
  constructor({
    store,
    now = () => new Date(),
    matchHistoryLimit = null,
    evidenceRefLimit = null,
    inspectionWindowLimit = null,
  }) {
    if(inspectionWindowLimit !== null &&
        (!Number.isSafeInteger(inspectionWindowLimit) ||
         inspectionWindowLimit<1 || inspectionWindowLimit>100)) {
      throw new RangeError('inspectionWindowLimit must be an integer 1..100');
    }
    if (evidenceRefLimit !== null &&
        (!Number.isInteger(evidenceRefLimit) ||
          evidenceRefLimit < 1 || evidenceRefLimit > 500)) {
      throw new RangeError('evidenceRefLimit must be an integer from 1 to 500');
    }
    if (matchHistoryLimit !== null &&
        (!Number.isInteger(matchHistoryLimit) ||
          matchHistoryLimit < 1 || matchHistoryLimit > 500)) {
      throw new RangeError('matchHistoryLimit must be an integer from 1 to 500');
    }
    if(inspectionWindowLimit!==null &&
       (evidenceRefLimit===null || matchHistoryLimit===null)) {
      throw new RangeError('Strict inspection requires evidenceRefLimit and matchHistoryLimit');
    }
    this.store = store;
    this.now = now;
    this.matchHistoryLimit = matchHistoryLimit;
    this.evidenceRefLimit = evidenceRefLimit;
    this.inspectionWindowLimit = inspectionWindowLimit;
  }

  async inspect({
    triggerId,
    version,
    matchId,
  }) {
    if(this.inspectionWindowLimit!==null && (!version ||
       typeof this.store.getTrigger!=='function' ||
       typeof this.store.getRecentTriggerMatchHistory!=='function' ||
       typeof this.store.getBoundedInspectionMatch!=='function' ||
       typeof this.store.getBoundedInspectionDeadlines!=='function' ||
       typeof this.store.getBoundedInspectionDerivedEvents!=='function')) {
      const error=new Error('Strict inspection requires version and bounded match store');
      error.code='EVENT_INTELLIGENCE_INSPECTION_STORE_UNSUPPORTED';
      throw error;
    }
    // A precise, versioned inspection should not read all definitions from
    // a high-cardinality scope. Legacy host stores retain the list fallback.
    const directRaw = version && typeof this.store.getTrigger === 'function'
      ? await this.store.getTrigger(triggerId, version) : null;
    const directDefinition = this.inspectionWindowLimit !== null && directRaw
      ? safeInspectionJson(directRaw, 65536).snapshot : directRaw;
    // Legacy key concatenation (triggerId + '@' + version) can alias
    // different input pairs containing '@'. Never trust a keyed hit's
    // identity without comparing its canonical stored fields.
    const canonicalDefinition = directDefinition?.triggerId === triggerId &&
      directDefinition?.version === version ? directDefinition : null;
    const candidates = version && typeof this.store.getTrigger === 'function'
      ? (canonicalDefinition ? [canonicalDefinition] : [])
      : (await this.store.listTriggers())
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

    const rawState = await this.store.getTriggerState(
      definition.triggerId,
      definition.version,
    );
    const state = this.inspectionWindowLimit !== null
      ? safeInspectionJson(rawState, 3145728).snapshot : rawState;

    let match;
    if(this.inspectionWindowLimit!==null){
      match=await this.store.getBoundedInspectionMatch({
        triggerId:definition.triggerId,version:definition.version,
        matchId:matchId??null,
      });
    } else if (matchId && typeof this.store.getTriggerMatch === 'function') {
      const row = await this.store.getTriggerMatch(matchId);
      match = row?.triggerId === definition.triggerId &&
        row?.triggerVersion === definition.version ? row : null;
    } else if (!matchId && typeof this.store.getLatestTriggerMatch === 'function') {
      const row = await this.store.getLatestTriggerMatch(
        definition.triggerId, definition.version);
      // Enforce identity even when custom stores supply a poisoned selector.
      match = row?.triggerId === definition.triggerId &&
        row?.triggerVersion === definition.version ? row : null;
    } else {
      const matches = (await this.store.listTriggerMatches(definition.triggerId))
        .filter((row) => row.triggerVersion === definition.version);
      match = matchId
        ? matches.find((candidate) => candidate.matchId === matchId) ?? null
        : latest(matches);
    }

    if (this.inspectionWindowLimit !== null && match) {
      match = safeInspectionJson(match, 65536).snapshot;
    }
    if(this.inspectionWindowLimit!==null && match &&
       (match.triggerId!==definition.triggerId ||
        match.triggerVersion!==definition.version ||
        (matchId && match.matchId!==matchId))) {
      const error=new Error('Bounded inspection selector returned foreign match identity');
      error.code='EVENT_INTELLIGENCE_INSPECTION_MATCH_IDENTITY_INVALID';
      throw error;
    }

    if (matchId && !match) {
      const error = new Error(`Unknown trigger match: ${matchId}`);
      error.code = 'TRIGGER_MATCH_NOT_FOUND';
      throw error;
    }

    // Strict mode refuses unexpectedly large definition/output state rather
    // than fabricating an incomplete reason from a truncated Pattern AST.
    if (this.inspectionWindowLimit !== null) {
      strictByteBudget(definition, 65536);
    }
    const evidenceProjection = clauseState(definition, match, this.evidenceRefLimit);
    const clauses = evidenceProjection.clauses;
    const totalSourceRefs = match?.sourceEvents?.length ?? 0;
    let deadlines=[];
    if(match && this.inspectionWindowLimit !== null) {
      if(typeof this.store.getBoundedInspectionDeadlines!=='function') {
        const error=new Error('Store does not support bounded inspection deadlines');
        error.code='EVENT_INTELLIGENCE_INSPECTION_STORE_UNSUPPORTED';
        throw error;
      }
      const rawPage=await this.store.getBoundedInspectionDeadlines(match.matchId,{
        limit:this.inspectionWindowLimit,
      });
      const page=safeInspectionJson(rawPage, 2097152).snapshot;
      if(!page || !Array.isArray(page.records) ||
          page.records.length>this.inspectionWindowLimit ||
          typeof page.hasMore!=='boolean' || page.hasMore) {
        const error=new Error('Inspection deadlines exceeded bounded proof window');
        error.code='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED';
        throw error;
      }
      deadlines=strictPageBudget(page.records, 16384, 1048576);
    } else {
      deadlines=match && this.store.listTemporalDeadlines
        ? await this.store.listTemporalDeadlines({matchId:match.matchId}) : [];
    }
    const pendingDeadlines = deadlines.filter(
      (deadline) => deadline.status === 'pending',
    );
    const nextEvaluationAt = pendingDeadlines
      .map((deadline) => deadline.dueAt)
      .sort()[0] ?? null;

    // Failed deliveries do not set firedWakeId. Derive the same stable
    // wake ID as CompositeWakeCoordinator from the selected match + target,
    // then read only that one wake (no unbounded global history scan).
    const wakeId = match?.firedWakeId ?? (match && definition.target
      ? 'wake_' + (await sha256Hex(
          `composite:${match.matchId}:${definition.target.runtime}:${definition.target.id}`,
        )).slice(0, 24)
      : null);
    const rawWake = wakeId ? await this.store.latestWake(wakeId) : null;
    const wake = this.inspectionWindowLimit !== null && rawWake
      ? safeInspectionJson(rawWake, 65536).snapshot : rawWake;

    let derivedOutputs=[];
    if(match && this.inspectionWindowLimit !== null) {
      if(typeof this.store.getBoundedInspectionDerivedEvents!=='function') {
        const error=new Error('Store does not support bounded inspection derived events');
        error.code='EVENT_INTELLIGENCE_INSPECTION_STORE_UNSUPPORTED';
        throw error;
      }
      const rawPage=await this.store.getBoundedInspectionDerivedEvents(match.matchId,{
        limit:this.inspectionWindowLimit,
      });
      const page=safeInspectionJson(rawPage, 2097152).snapshot;
      if(!page || !Array.isArray(page.records) ||
          page.records.length>this.inspectionWindowLimit ||
          typeof page.hasMore!=='boolean' || page.hasMore) {
        const error=new Error('Inspection derived records exceeded bounded proof window');
        error.code='EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED';
        throw error;
      }
      derivedOutputs=strictPageBudget(page.records, 16384, 1048576);
    } else {
      derivedOutputs=match
        ? (await this.store.listDerivedEvents?.({matchId:match.matchId}) ?? []) : [];
    }
    const selectedDerivedOutputs = this.evidenceRefLimit === null
      ? derivedOutputs : derivedOutputs.slice(0, this.evidenceRefLimit);

    // Use the storage adapter's indexed recent-history query when the
    // caller explicitly requests a bounded window. For custom stores without
    // that optional optimization, retain the ordinary history path.
    let recentHistory = [];
    let historyTruncated = false;
    if (match && this.matchHistoryLimit !== null &&
        typeof this.store.getRecentTriggerMatchHistory === 'function') {
      const rawWindow = await this.store.getRecentTriggerMatchHistory(
        match.matchId,
        {
          limit: this.matchHistoryLimit,
          ...(this.inspectionWindowLimit !== null
            ? { maxRowBytes: 65536, maxTotalBytes: 1048576, maxScanMs: 2000 }
            : {}),
        },
      );
      const window = this.inspectionWindowLimit !== null
        ? safeInspectionJson(rawWindow, 2097152).snapshot : rawWindow;
      if (!window || !Array.isArray(window.records) ||
          window.records.length > this.matchHistoryLimit ||
          typeof window.hasMore !== 'boolean' ||
          !window.records.every(validHistoryProjection)) {
        const error = new Error('Store returned invalid bounded history window');
        error.code = 'EVENT_INTELLIGENCE_HISTORY_WINDOW_INVALID';
        throw error;
      }
      // Custom stores may ignore requested byte caps. Fail closed on both
      // individual row size and cumulative history, not only row count.
      if (this.inspectionWindowLimit !== null) {
        let historyBytes = 0;
        for (const record of window.records) {
          const rowBytes = strictByteBudget(record, 65536);
          historyBytes += rowBytes;
          if (rowBytes > 65536 || historyBytes > 1048576) {
            const error = new Error('Inspection history exceeds byte budget');
            error.code = 'EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED';
            throw error;
          }
        }
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
    // Only an explicitly implemented scoped store capability supplies
    // additional persisted explain facts. No provider event data is trusted
    // as a source availability, watermark or evaluator-completeness proof.
    // Strict inspection may call only an explicitly implemented bounded
    // scope source-fact capability; custom/unbounded stores remain unknown.
    const explainArgs={
      triggerId:definition.triggerId,
      triggerVersion:definition.version,
      matchId:match?.matchId??null,
    };
    const explainFact=this.inspectionWindowLimit!==null
      ? (typeof this.store.getBoundedInspectionFact==='function'
        ? await this.store.getBoundedInspectionFact({
          ...explainArgs,limit:this.inspectionWindowLimit,
        }) : null)
      : (typeof this.store.getInspectionFact==='function'
        ? await this.store.getInspectionFact(explainArgs) : null);
    const matchHistory = recentHistory.map((record) => ({
      status: record.status,
      updatedAt: record.updatedAt,
      firedWakeId: record.firedWakeId,
      derivedEventIds: record.derivedEventIds ?? [],
      sourceEventIds: record.sourceEvents.map(
        (event) => event.sourceEventId,
      ),
    }));

    const inspection = {
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
        evidenceRefLimit: this.evidenceRefLimit,
        inspectionWindowLimit: this.inspectionWindowLimit,
        sourceRefCount: totalSourceRefs,
        sourceRefsTruncated: totalSourceRefs > evidenceProjection.selected.length,
        derivedRefCount: derivedOutputs.length,
        derivedRefsTruncated: derivedOutputs.length > selectedDerivedOutputs.length,
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
        evidence: evidenceProjection.selected,
        derivedOutputs: selectedDerivedOutputs.map((record) => ({
          eventId: record.event.sourceEventId,
          eventName: record.event.name,
          ...derivedMetadata(record.event.data),
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
      // Never claim upstream absence or expose payload/host instructions.
      causalTimeline: createCausalTimeline({ match, wake }),
      diagnosis: diagnosticState({
        state, match, wake, clauses, pendingDeadlines, definition,
      }),
      diagnosisV2: classifyExplainReason({
        state, trigger: definition, match, wake, pendingDeadlines,
        fact: explainFact,
      }),
    };
    // A bounded history is not a bounded whole response: lifecycle,
    // definition, derived lineage and causal timeline also contribute bytes.
    if (this.inspectionWindowLimit !== null) {
      return safeInspectionJson(inspection, 3145728).snapshot;
    }
    return inspection;
  }
}

class SimulationStore {
  constructor(now = () => new Date()) {
    this.now = now;
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
      updatedAt: this.now().toISOString(),
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
      createdAt: previous?.createdAt ?? this.now().toISOString(),
      updatedAt: this.now().toISOString(),
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
      updatedAt: this.now().toISOString(),
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
  startAt,
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

  // An explicit clock anchor makes even empty-event simulations repeatable.
  // Keep legacy event-time anchoring when startAt is omitted. All SimulationStore
  // timestamps must use this injected clock, never the wall clock.
  const startValid = startAt === undefined ||
    simulationTimestamp.safeParse(startAt).success;
  const startMs = startValid && startAt !== undefined ? Date.parse(startAt) : null;
  if (!startValid || (startAt !== undefined && !Number.isFinite(startMs))) {
    const error = new TypeError(
      'Simulation startAt must be a valid offset-aware ISO timestamp',
    );
    error.code = 'EVENT_SIMULATION_START_TIME_INVALID';
    throw error;
  }
  const untilValid = until === undefined ||
    simulationTimestamp.safeParse(until).success;
  const untilMs = untilValid && until !== undefined ? Date.parse(until) : null;
  if (!untilValid || (until !== undefined && !Number.isFinite(untilMs))) {
    const error = new TypeError(
      'Simulation until must be a valid offset-aware ISO timestamp',
    );
    error.code = 'EVENT_SIMULATION_END_TIME_INVALID';
    throw error;
  }
  if (startMs !== null && untilMs !== null && untilMs < startMs) {
    const error = new RangeError('Simulation until cannot precede startAt');
    error.code = 'EVENT_SIMULATION_TIME_RANGE_INVALID';
    throw error;
  }

  let clock = new Date(startMs ??
    (normalized.length ? Date.parse(normalized[0].occurredAt) : Date.now()));
  const store = new SimulationStore(() => clock);
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

  const untilTime = untilMs;

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
