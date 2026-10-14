import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema,
  evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

const origin = Date.UTC(2026, 9, 14, 12, 0, 0);
const windows = [
  { type: 'within', sizeMs: 400 },
  { type: 'sliding', sizeMs: 400 },
  { type: 'tumbling', sizeMs: 600, offsetMs: 0 },
  { type: 'hopping', sizeMs: 600, hopMs: 300, offsetMs: 0 },
  { type: 'session', gapMs: 400 },
  { type: 'count', size: 3 },
];

function source(kind, seed, index) {
  return {
    clauseId: kind,
    traceId: 'window:' + seed + ':' + index,
    sourceEventId: 'window:' + seed + ':' + (99 - index),
    eventName: kind + '.event',
    occurredAt: new Date(origin + index * 200).toISOString(),
    provider: 'independent-reference',
    serverId: 'window-oracle',
    subscriptionArguments: {},
    data: {},
  };
}

function seeded(seed) {
  let state = (Math.imul(seed, 2654435761) ^ 0x76897a6) >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function definition(window) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: {
      kind: 'window', window,
      child: {
        kind: 'allOf',
        children: [
          { kind: 'event', ref: 'a' },
          { kind: 'event', ref: 'b' },
        ],
      },
    },
    partitionBy: [],
    selection: {
      overlap: 'allow',
      afterMatch: 'keepAll',
      maxMatchesPerEvent: 100,
    },
    execution: {
      maxCandidates: 512,
      maxSemanticEvaluations: 0,
      maxBufferedEvents: 512,
    },
  });
}

// Independent, finite Cartesian reference model. It knows nothing about
// candidate-merger, temporal window helpers or selection implementation.
function pairFits(events, a, b, window) {
  const left = Date.parse(a.occurredAt);
  const right = Date.parse(b.occurredAt);
  const lo = Math.min(left, right);
  const hi = Math.max(left, right);
  if (window.type === 'within' || window.type === 'sliding') {
    return hi - lo <= window.sizeMs;
  }
  if (window.type === 'session') {
    return hi - lo <= window.gapMs;
  }
  if (window.type === 'count') {
    const indices = [a, b].map(ev => events.indexOf(ev));
    return Math.abs(indices[0] - indices[1]) + 1 <= window.size;
  }
  if (window.type === 'tumbling') {
    return Math.floor((lo - window.offsetMs) / window.sizeMs) ===
      Math.floor((hi - window.offsetMs) / window.sizeMs);
  }
  if (window.type === 'hopping') {
    const first = Math.floor((lo - window.offsetMs - window.sizeMs) / window.hopMs) - 1;
    const last = Math.ceil((hi - window.offsetMs) / window.hopMs) + 1;
    for (let k = first; k <= last; k++) {
      const start = window.offsetMs + k * window.hopMs;
      if (start <= lo && hi < start + window.sizeMs) return true;
    }
    return false;
  }
  throw new TypeError('Unsupported finite window model: ' + window.type);
}

function referencePairs(events, window) {
  if (!Array.isArray(events) || events.length < 2 || events.length > 9 ||
      !windows.some(item => item.type === window?.type)) {
    throw new TypeError('Finite window oracle requires 2..9 events and supported window type');
  }
  const chronological = [...events].sort((x, y) =>
    Date.parse(x.occurredAt) - Date.parse(y.occurredAt));
  const ids = new Set();
  for (let i = 0; i < chronological.length; i++) {
    const ev = chronological[i];
    if (!['a', 'b', 'noise'].includes(ev.clauseId) ||
        !ev.sourceEventId || ids.has(ev.sourceEventId) ||
        !Number.isFinite(Date.parse(ev.occurredAt)) ||
        (i > 0 && Date.parse(ev.occurredAt) <=
          Date.parse(chronological[i - 1].occurredAt))) {
      throw new TypeError('Finite window oracle requires unique chronological source evidence');
    }
    ids.add(ev.sourceEventId);
  }
  const pairs = [];
  for (const a of chronological.filter(e => e.clauseId === 'a')) {
    for (const b of chronological.filter(e => e.clauseId === 'b')) {
      if (pairFits(chronological, a, b, window)) {
        pairs.push([a.sourceEventId, b.sourceEventId]);
      }
    }
  }
  return pairs.sort((x, y) => x.join('|').localeCompare(y.join('|')));
}

function actualPairs(result) {
  return result.matches.map(c => [
    c.bindings.a?.[0]?.sourceEventId,
    c.bindings.b?.[0]?.sourceEventId,
  ]).sort((a, b) => a.join('|').localeCompare(b.join('|')));
}

for (const window of windows) {
  test('nested allOf matches finite independent ' + window.type + ' window oracle', async () => {
    const config = definition(window);
    let witnessedPositive = 0;
    let witnessedNegative = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const rand = seeded(seed);
      const length = 2 + ((seed - 1) % 8);
      const chronological = Array.from({ length }, (_, index) =>
        source(index === 0 ? 'a' : index === 1 ? 'b' :
          ['a', 'b', 'noise'][Math.floor(rand() * 3)], seed, index));
      const expected = referencePairs(chronological, window);
      const totalPairs =
        chronological.filter(x => x.clauseId === 'a').length *
        chronological.filter(x => x.clauseId === 'b').length;
      witnessedPositive += expected.length;
      witnessedNegative += totalPairs - expected.length;
      const orderings = [
        chronological,
        [...chronological].reverse(),
        [...chronological.slice(1), chronological[0]],
      ];
      for (const [round, arrival] of orderings.entries()) {
        const result = await evaluatePatternV2({
          definition: config,
          events: arrival,
          now: new Date('2026-10-15T00:00:00Z'),
        });
        assert.equal(result.truncated, false,
          window.type + '/seed=' + seed + '/round=' + round);
        assert.deepEqual(result.pending, [],
          window.type + ': non-temporal window must not report pending absence');
        assert.deepEqual(actualPairs(result), expected,
          window.type + '/seed=' + seed + '/round=' + round +
            '/source=' + chronological.map(x => x.clauseId).join(','));
      }
    }
    assert.ok(witnessedPositive > 0 && witnessedNegative > 0,
      window.type + ' must exercise both accepted and rejected pairs');
  });
}

test('finite oracle detects inclusive-boundary mutation and rejects unsupported inputs', () => {
  const events = [
    source('a', 1, 0),
    source('noise', 1, 1),
    source('b', 1, 2),
  ];
  assert.equal(referencePairs(events, { type: 'within', sizeMs: 400 }).length, 1);
  assert.equal(referencePairs(events, { type: 'within', sizeMs: 399 }).length, 0);
  assert.throws(() => referencePairs(events, { type: 'unsupported' }),
    /supported window type/);
  assert.throws(() => referencePairs([events[0], events[0]], windows[0]),
    /unique chronological/);
});
