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
  if (!Array.isArray(events) || events.length < 1 || events.length > 10) {
    throw new TypeError('Negative-window oracle requires 1..10 events');
  }
  const seen = new Set();
  for (const item of events) {
    if (!item || !['a','b','noise'].includes(item.clauseId) ||
        typeof item.sourceEventId !== 'string' || !item.sourceEventId ||
        seen.has(item.sourceEventId) ||
        !Number.isFinite(Date.parse(item.occurredAt))) {
      throw new TypeError('Negative-window oracle requires unique valid a/b/noise events');
    }
    seen.add(item.sourceEventId);
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
