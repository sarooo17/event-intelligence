import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

// Reference-only causal evidence for host-authorized inspector results.
// Output and retained selection memory are fixed at 32 references. Selecting
// the same 32 after reordered persistence requires inspecting each source
// record once; hosts must independently bound source-event cardinality.
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
  // Revoked proxies throw from Array.isArray(): test the native proxy brand
  // first to fail closed without evaluating user traps.
  const events = isProxy(source) ? [] : Array.isArray(source) ? source : [];
  const selected = [];
  for (let i = 0; i < events.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(events, String(i));
    if (!slot || !Object.hasOwn(slot, 'value')) continue;
    const event = slot.value;
    const sourceEventId = reference(own(event, 'sourceEventId'));
    if (!sourceEventId) continue;
    const item = Object.freeze({
      stage: 'source_observed',
      sourceRef: sourceEventId,
      clauseRef: reference(own(event, 'clauseId')),
      traceRef: reference(own(event, 'traceId')),
      occurredAt: validInstant(own(event, 'occurredAt')),
    });
    // Stable subset on every permutation of the same persisted evidence,
    // unlike sorting only the first 32 returned by the store.
    const key = [item.clauseRef ?? '',item.sourceRef,
      item.traceRef ?? '',item.occurredAt ?? ''].join('|');
    if (selected.length===CAUSAL_TIMELINE_SOURCE_LIMIT &&
        key>=selected.at(-1).key) continue;
    const at=selected.findIndex(row=>row.key>key);
    selected.splice(at<0?selected.length:at,0,{key,item});
    if(selected.length>CAUSAL_TIMELINE_SOURCE_LIMIT)selected.pop();
  }
  const entries = selected.map(row=>row.item);

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
      status: ['queued', 'pending', 'claimed', 'delivered', 'failed', 'dead_letter']
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
