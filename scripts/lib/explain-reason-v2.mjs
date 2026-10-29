import { isProxy } from 'node:util/types';

// A separate versioned layer; existing diagnosis v1 is untouched.
export const EXPLAIN_REASON_VERSION = 'ei.trigger-explain-reason.v2';

function own(row, key) {
  if (!row || typeof row !== 'object' || isProxy(row)) return undefined;
  const slot = Object.getOwnPropertyDescriptor(row, key);
  return slot && Object.hasOwn(slot, 'value') ? slot.value : undefined;
}
const FACTS = new Set([
  'source_unavailable', 'watermark_pending',
  'budget_truncated', 'candidate_impossible',
]);

// Facts come ONLY from the host-trusted scoped store capability. Never
// construct these from untrusted MCP payload, agent text or host hint strings.
function scopedFact(fact, trigger, match) {
  if (own(fact, 'contract') !== 'ei.inspection-fact.v1' ||
      own(fact, 'triggerId') !== own(trigger, 'triggerId') ||
      own(fact, 'triggerVersion') !== own(trigger, 'version') ||
      own(fact, 'matchId') !== (own(match, 'matchId') ?? null) ||
      own(fact, 'durable') !== true) return null;
  const kind = own(fact, 'kind');
  if (!FACTS.has(kind)) return null;
  // A candidate can be proven impossible only with a particular persisted
  // candidate and explicit terminal proof; no-match isn't that proof.
  if (kind === 'candidate_impossible' &&
      (!match || own(fact, 'terminal') !== true)) return null;
  return kind;
}

export function classifyExplainReason({
  state, trigger, match, wake, pendingDeadlines = [], fact = null,
}) {
  const status = own(state, 'status');
  const matchStatus = own(match, 'status');
  const wakeStatus = own(wake, 'status');
  let kind;
  let basis = 'persisted_local';
  let scope = 'trigger';
  if (status === 'paused') kind = 'paused';
  else if (status === 'expired' || status === 'completed' || status === 'deleted') {
    kind = 'lifecycle_ended';
  } else if (wakeStatus === 'dead_letter') kind = 'wake_failed';
  else if (matchStatus === 'expired') {
    kind = 'candidate_expired';
    scope = 'selected_match';
  } else if (matchStatus === 'fired') kind = 'fired';
  else if (matchStatus === 'emitted') kind = 'derived_emitted';
  else if (matchStatus === 'matched') {
    kind = own(trigger, 'conditionOnly') === true
      ? 'condition_satisfied' : 'waiting_delivery';
    scope = 'selected_match';
  } else {
    const verifiedFact = scopedFact(fact, trigger, match);
    if (verifiedFact) {
      kind = verifiedFact;
      basis = 'scoped_store_fact';
      scope = verifiedFact === 'candidate_impossible' ? 'selected_match' : 'trigger';
    } else if (Array.isArray(pendingDeadlines) &&
        pendingDeadlines.some(row => own(row, 'status') === 'pending')) {
      kind = 'deadline_pending';
      scope = 'selected_match';
    } else {
      kind = 'not_yet_satisfied';
    }
  }
  return Object.freeze({
    contract: EXPLAIN_REASON_VERSION, kind, basis, scope,
    upstreamCompleteness: 'unknown',
  });
}
