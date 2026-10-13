import * as z from 'zod/v4';

const isoTimestamp = z.iso.datetime({ offset: true });

/**
 * Independent finite reference model for
 * notPresent(b, allOf(event(a),event(c))) in a single unpartitioned snapshot.
 *
 * Do NOT import evaluator candidate merge / selection helpers here.
 * Every Cartesian (a,c) pair has a chronological [min,max] span.
 * A b event anywhere inside that span invalidates only that pair.
 */
export function referenceNestedNotPresentPairs(events) {
  if (!Array.isArray(events) || events.length < 1 || events.length > 9) {
    throw new TypeError('Nested notPresent reference requires 1..9 events');
  }
  const ids = new Set();
  const instants = new Set();
  for (const event of events) {
    if (!event || !['a', 'b', 'c', 'noise'].includes(event.clauseId) ||
        typeof event.sourceEventId !== 'string' || !event.sourceEventId ||
        ids.has(event.sourceEventId) ||
        !isoTimestamp.safeParse(event.occurredAt).success) {
      throw new TypeError('Nested notPresent requires unique supported source events');
    }
    const timestamp = Date.parse(event.occurredAt);
    if (!Number.isSafeInteger(timestamp) || instants.has(timestamp)) {
      throw new TypeError('Nested notPresent requires distinct safe timestamps');
    }
    ids.add(event.sourceEventId);
    instants.add(timestamp);
  }
  const timeSorted = events
    .map(event => ({ ...event, epoch: Date.parse(event.occurredAt) }))
    .sort((left, right) => left.epoch - right.epoch);
  const anchors = timeSorted.filter(event => event.clauseId === 'a');
  const completions = timeSorted.filter(event => event.clauseId === 'c');
  const forbidden = timeSorted.filter(event => event.clauseId === 'b');
  const pairs = [];
  for (const a of anchors) {
    for (const c of completions) {
      const start = Math.min(a.epoch, c.epoch);
      const end = Math.max(a.epoch, c.epoch);
      // Check the chosen pair's *span*, not a global absence condition.
      if (forbidden.some(b => b.epoch >= start && b.epoch <= end)) continue;
      pairs.push([a.sourceEventId, c.sourceEventId]);
    }
  }
  return pairs.sort((left, right) =>
    left.join('|').localeCompare(right.join('|')));
}
