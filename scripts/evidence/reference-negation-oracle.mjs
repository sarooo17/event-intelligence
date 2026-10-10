/**
 * Tiny independent reference for the event-time notFollowedBy subset.
 * It intentionally does not import Pattern AST implementation helpers.
 * No partitions, no nested patterns, no nontrivial selection policies.
 */
export function referenceNotFollowedBy(events, {
  withinMs,
  allowedLatenessMs,
  nowMs,
} = {}) {
  if (!Number.isFinite(withinMs) || withinMs <= 0 ||
      !Number.isFinite(allowedLatenessMs) || allowedLatenessMs < 0 ||
      !Number.isFinite(nowMs)) {
    throw new TypeError('Invalid bounded negative-window oracle parameters');
  }
  const matches = [];
  const pending = [];
  for (const anchor of events) {
    if (anchor.clauseId !== 'a') continue;
    const start = Date.parse(anchor.occurredAt);
    const deadline = start + withinMs;
    const blocked = events.some((candidate) =>
      candidate.clauseId === 'b' &&
      Date.parse(candidate.occurredAt) > start &&
      Date.parse(candidate.occurredAt) <= deadline
    );
    if (blocked) continue;
    const out = nowMs >= deadline + allowedLatenessMs ? matches : pending;
    out.push(anchor.sourceEventId);
  }
  matches.sort();
  pending.sort();
  return { matches, pending };
}
