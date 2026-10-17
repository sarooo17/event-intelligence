import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

// Reference-only causal evidence for host-authorized inspector results.
// The maximum is deliberately fixed, not host-configurable without a new
// version, so hostile high-cardinality matches cannot amplify tracing work.
export const CAUSAL_TIMELINE_VERSION = 'ei.causal-timeline.v1';
export const CAUSAL_TIMELINE_SOURCE_LIMIT = 32;

function own(value, key) {
  if (!value || typeof value !== 'object' || isProxy(value)) return undefined;
  const slot = Object.getOwnPropertyDescriptor(value, key);
  return slot && Object.hasOwn(slot, 'value') ? slot.value : undefined;
}

function reference(value) {
  if (typeof value !== 'string' || !value.length) return null;
  return 'sha256:' + createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function validInstant(value) {
  return typeof value === 'string' && value.length <= 40 &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * Snapshot only bounded, hashed references from persisted records. Missing
 * records remain unknown; we do not infer whether an upstream event occurred
 * or an external host side effect succeeded without a persisted receipt.
 * No event payload, semantic rationale or host instruction enters the output.
 */
export function createCausalTimeline({ match, wake } = {}) {
  const source = own(match, 'sourceEvents');
  const events = Array.isArray(source) && !isProxy(source) ? source : [];
  const entries = [];
  const limit = Math.min(events.length, CAUSAL_TIMELINE_SOURCE_LIMIT);
  for (let i = 0; i < limit; i++) {
    const slot = Object.getOwnPropertyDescriptor(events, String(i));
    if (!slot || !Object.hasOwn(slot, 'value')) continue;
    const event = slot.value;
    const sourceEventId = reference(own(event, 'sourceEventId'));
    if (!sourceEventId) continue;
    entries.push(Object.freeze({
      stage: 'source_observed',
      sourceRef: sourceEventId,
      clauseRef: reference(own(event, 'clauseId')),
      traceRef: reference(own(event, 'traceId')),
      occurredAt: validInstant(own(event, 'occurredAt')),
    }));
  }
  // Stable across store restarts when source occurrence storage order changes.
  entries.sort((a, b) =>
    (a.clauseRef ?? '').localeCompare(b.clauseRef ?? '') ||
    a.sourceRef.localeCompare(b.sourceRef));

  const matchId = reference(own(match, 'matchId'));
  if (matchId) entries.push(Object.freeze({
    stage: 'match_recorded',
    matchRef: matchId,
    status: ['partial', 'matched', 'fired', 'expired', 'emitted']
      .includes(own(match, 'status')) ? own(match, 'status') : 'unknown',
    updatedAt: validInstant(own(match, 'updatedAt')),
  }));
  const wakeId = reference(own(wake, 'wakeId'));
  if (wakeId) {
    entries.push(Object.freeze({
      stage: 'wake_recorded',
      wakeRef: wakeId,
      status: ['pending', 'claimed', 'delivered', 'failed', 'dead_letter']
        .includes(own(wake, 'status')) ? own(wake, 'status') : 'unknown',
      createdAt: validInstant(own(wake, 'createdAt')),
    }));
    if (reference(own(wake, 'runtimeReceiptId'))) {
      entries.push(Object.freeze({
        stage: 'host_receipt_recorded',
        receiptRef: reference(own(wake, 'runtimeReceiptId')),
      }));
    }
  }

  return Object.freeze({
    contract: CAUSAL_TIMELINE_VERSION,
    sourceLimit: CAUSAL_TIMELINE_SOURCE_LIMIT,
    sourceCount: entries.filter(entry => entry.stage === 'source_observed').length,
    sourceTruncated: events.length > CAUSAL_TIMELINE_SOURCE_LIMIT,
    // No claim of event completeness or authoritative host effect.
    upstreamCompleteness: 'unknown',
    entries: Object.freeze(entries),
  });
}
