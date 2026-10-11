/**
 * Independent, bounded allOf oracle for two distinct event refs (a, b).
 * Cartesian enumeration is deliberately separate from Pattern v2's
 * candidate-merging and after-match code.
 *
 * Domain: 1..9 unique occurrences; no partition/window/predicate/semantic;
 * allow-overlap + keepAll; unlimited enough execution caps.
 */
export function referenceAllOfPairs(events) {
  if (!Array.isArray(events) || events.length < 1 || events.length > 9) {
    throw new TypeError('AllOf reference corpus must contain 1..9 events');
  }
  const seen = new Set();
  for (const entry of events) {
    if (!entry || typeof entry !== 'object' ||
        !['a', 'b', 'noise'].includes(entry.clauseId) ||
        typeof entry.sourceEventId !== 'string' ||
        entry.sourceEventId.length === 0 ||
        seen.has(entry.sourceEventId)) {
      throw new TypeError('AllOf reference oracle needs unique supported events');
    }
    seen.add(entry.sourceEventId);
  }
  const a = events.filter(item => item.clauseId === 'a');
  const b = events.filter(item => item.clauseId === 'b');
  const pairs = [];
  for (const left of a) {
    for (const right of b) {
      pairs.push([left.sourceEventId, right.sourceEventId]);
    }
  }
  return pairs.sort((x, y) => x.join('|').localeCompare(y.join('|')));
}
