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
