/**
 * Independent finite oracle for Pattern v2 anyOf over two distinct event
 * references (a|b). It deliberately does not call Pattern AST evaluator code
 * or its binding/match helpers.
 *
 * Domain: 1..9 unique occurrences, no predicates/partitions/semantic/window,
 * keepAll/allow-overlap with sufficiently high execution limits.
 */
export function referenceAnyOfIds(events) {
  if (!Array.isArray(events) || events.length < 1 || events.length > 9) {
    throw new TypeError('anyOf oracle accepts 1..9 events');
  }
  const seen = new Set();
  const ids = [];
  for (const event of events) {
    if (!event || typeof event !== 'object' ||
        !['a', 'b', 'noise'].includes(event.clauseId) ||
        typeof event.sourceEventId !== 'string' || !event.sourceEventId ||
        seen.has(event.sourceEventId)) {
      throw new TypeError('anyOf oracle requires unique a/b/noise event IDs');
    }
    seen.add(event.sourceEventId);
    if (event.clauseId === 'a' || event.clauseId === 'b') {
      ids.push(event.sourceEventId);
    }
  }
  return ids.sort();
}
