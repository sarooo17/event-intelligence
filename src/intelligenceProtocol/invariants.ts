import type {
  EventLineage,
  SemanticDecisionRecord,
  WakeRecord,
} from './schemas.js';

export function assertDecisionLineage(
  event: EventLineage,
  decision: SemanticDecisionRecord,
): void {
  if (decision.traceId !== event.traceId) {
    throw new Error('Decision traceId does not match source event');
  }
  if (decision.subscriptionId !== event.subscriptionId) {
    throw new Error('Decision subscriptionId does not match source event');
  }
  if (decision.sourceEventId !== event.sourceEventId) {
    throw new Error('Decision sourceEventId does not match source event');
  }
}

export function assertWakeLineage(
  event: EventLineage,
  decision: SemanticDecisionRecord | null,
  wake: WakeRecord,
): void {
  if (wake.traceId !== event.traceId) {
    throw new Error('Wake traceId does not match source event');
  }
  if (wake.subscriptionId !== event.subscriptionId) {
    throw new Error('Wake subscriptionId does not match source event');
  }
  if (wake.sourceEventId !== event.sourceEventId) {
    throw new Error('Wake sourceEventId does not match source event');
  }
  if (decision) {
    assertDecisionLineage(event, decision);
    if (wake.decisionId !== decision.decisionId) {
      throw new Error('Wake decisionId does not match semantic decision');
    }
  } else if (wake.decisionId !== null) {
    throw new Error('Wake has decisionId but no decision record was supplied');
  }
  if (
    wake.target.runtime !== event.target.runtime ||
    wake.target.kind !== event.target.kind ||
    wake.target.id !== event.target.id
  ) {
    throw new Error('Wake target does not match source event target');
  }
}
