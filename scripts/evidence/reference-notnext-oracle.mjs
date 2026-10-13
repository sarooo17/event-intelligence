import * as z from 'zod/v4';

const isoTimestamp = z.iso.datetime({ offset: true });

/**
 * Independent finite-reference model of the *snapshot* semantics of
 * notNext(event(a),event(b)) on one unpartitioned stream.
 *
 * This is deliberately NOT implemented with Pattern candidate helpers.
 * A trailing a is returned in a finite snapshot, even though a live
 * stream may subsequently receive b. Do not interpret this as a durable
 * negative-match finality guarantee.
 */
export function referenceNotNext(events) {
  if (!Array.isArray(events) || events.length < 1 || events.length > 10) {
    throw new TypeError('notNext oracle requires 1..10 source occurrences');
  }
  const seenIds = new Set();
  const seenTimes = new Set();
  for (const item of events) {
    if (!item || !['a', 'b', 'noise'].includes(item.clauseId) ||
        typeof item.sourceEventId !== 'string' || !item.sourceEventId ||
        seenIds.has(item.sourceEventId) ||
        !isoTimestamp.safeParse(item.occurredAt).success) {
      throw new TypeError('notNext oracle requires unique valid a/b/noise occurrences');
    }
    const time = Date.parse(item.occurredAt);
    // Exact timestamp ties require Pattern's secondary ordering rules,
    // outside this intentionally bounded reference domain.
    if (!Number.isSafeInteger(time) || seenTimes.has(time)) {
      throw new TypeError('notNext oracle requires distinct safe event-time timestamps');
    }
    seenIds.add(item.sourceEventId);
    seenTimes.add(time);
  }
  const chronological = events
    .map(item => ({ item, at: Date.parse(item.occurredAt) }))
    .sort((left, right) => left.at - right.at);
  const matched = [];
  for (let index = 0; index < chronological.length; index += 1) {
    if (chronological[index].item.clauseId !== 'a') continue;
    // Immediate NEXT event is the next occurrence in the whole stream,
    // including unrelated noise, not the next b filtered from the stream.
    const next = chronological[index + 1]?.item;
    if (!next || next.clauseId !== 'b') {
      matched.push(chronological[index].item.sourceEventId);
    }
  }
  return matched.sort();
}
