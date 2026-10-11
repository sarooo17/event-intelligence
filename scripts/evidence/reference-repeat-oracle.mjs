/**
 * Exhaustive bounded independent reference model for a single-source Pattern
 * AST v2 repeat(event(x)). This module intentionally does not import Pattern
 * evaluator, candidate/binding utilities, or any production selector.
 *
 * Domain: 1..9 unique UTC occurrences, strict chronological timestamps,
 * two refs ('x' and 'noise'), repeat min 1..3 / max min..3, no windows,
 * partitioning, predicates, semantic nodes or execution truncation.
 *
 * The 'mode' preference (greedy/lazy) affects result order, not membership
 * under allow-overlap + keepAll and an adequate candidate budget.
 */
export function referenceRepeatIds(events, {
  min,
  max,
  contiguity,
} = {}) {
  if (!Array.isArray(events) || events.length < 1 || events.length > 9) {
    throw new TypeError('repeat reference accepts 1..9 events');
  }
  if (!Number.isInteger(min) || min < 1 || min > 3 ||
      !Number.isInteger(max) || max < min || max > 3 ||
      !['combinations', 'consecutive', 'relaxed'].includes(contiguity)) {
    throw new TypeError('repeat reference requires supported min/max/contiguity');
  }
  const seen = new Set();
  let last = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const timestamp = event?.occurredAt;
    const millis = typeof timestamp === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
      ? Date.parse(timestamp) : NaN;
    if (!event || !['x', 'noise'].includes(event.clauseId) ||
        typeof event.sourceEventId !== 'string' || !event.sourceEventId ||
        seen.has(event.sourceEventId) ||
        !Number.isFinite(millis) ||
        new Date(millis).toISOString() !== timestamp ||
        millis <= last) {
      throw new TypeError(
        'repeat reference requires unique, ordered UTC x/noise occurrences',
      );
    }
    seen.add(event.sourceEventId);
    last = millis;
  }

  const x = events.flatMap((event, index) =>
    event.clauseId === 'x' ? [{ id: event.sourceEventId, position: index }] : []);
  const expected = [];
  // Independent finite-set enumeration: every nonempty subset of eligible
  // source occurrences is considered once, then tested against the declared
  // contiguity rule without using production candidate walking logic.
  for (let mask = 1; mask < (1 << x.length); mask++) {
    const chosen = x.filter((_, index) => (mask & (1 << index)) !== 0);
    if (chosen.length < min || chosen.length > max) continue;
    if (contiguity === 'consecutive' && chosen.some((event, index) =>
      index > 0 && event.position !== chosen[index - 1].position + 1
    )) continue;
    if (contiguity === 'relaxed' && chosen.some((event, index) =>
      index > 0 &&
      // No other x may lie between chosen occurrences (noise is ignored).
      x.some(candidate => candidate.position > chosen[index - 1].position &&
        candidate.position < event.position)
    )) continue;
    expected.push(chosen.map(item => item.id));
  }
  return expected.sort((a, b) => a.join('|').localeCompare(b.join('|')));
}
