/**
 * Deliberately small independent oracle for the two-event sequence subset.
 *
 * This reference does NOT import Pattern AST implementation utilities; it
 * enumerates eligible event pairs directly from sorted event-time records.
 * Its limited domain is explicit: two event refs (a, b), no windows,
 * no partitions, selection allow/keepAll, bounded distinct occurrences.
 */
export function referenceSequencePairs(ordered, contiguity) {
  if (contiguity !== 'next' && contiguity !== 'followedBy') {
    throw new Error('Unknown reference contiguity: ' + contiguity);
  }
  if (!Array.isArray(ordered) || ordered.length < 1 || ordered.length > 8) {
    throw new TypeError('Sequence reference oracle requires 1..8 events');
  }
  const seen = new Set();
  let lastTime = -Infinity;
  for (const item of ordered) {
    const at = Date.parse(item?.occurredAt);
    if (!item || !['a','b','noise'].includes(item.clauseId) ||
        typeof item.sourceEventId !== 'string' || !item.sourceEventId ||
        seen.has(item.sourceEventId) || !Number.isFinite(at) ||
        at < lastTime) {
      throw new TypeError('Sequence reference oracle needs unique chronological a/b/noise events');
    }
    seen.add(item.sourceEventId);
    lastTime = at;
  }
  const pairs = [];
  for (let i = 0; i < ordered.length; i += 1) {
    if (ordered[i].clauseId !== 'a') continue;
    if (contiguity === 'next') {
      if (ordered[i + 1]?.clauseId === 'b') {
        pairs.push([ordered[i].sourceEventId, ordered[i + 1].sourceEventId]);
      }
      continue;
    }
    for (let j = i + 1; j < ordered.length; j += 1) {
      if (ordered[j].clauseId === 'b') {
        pairs.push([ordered[i].sourceEventId, ordered[j].sourceEventId]);
        break;
      }
    }
  }
  return pairs.sort((left, right) =>
    left.join('|').localeCompare(right.join('|')),
  );
}

/** Seeded LCG for deterministic regression, never used as cryptography. */
export function deterministicRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function shuffled(list, random) {
  const items = [...list];
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
