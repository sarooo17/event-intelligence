import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema,
  evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';
import { referenceNotFollowedBy } from '../scripts/evidence/reference-negation-oracle.mjs';

const epoch = Date.UTC(2026, 9, 14, 12, 0, 0);
const withinMs = 600;
const allowedLatenessMs = 200;

const definition = PatternAstV2DefinitionSchema.parse({
  version: '2',
  root: {
    kind: 'notFollowedBy',
    id: 'stable-absence',
    child: { kind: 'event', ref: 'a' },
    forbidden: { kind: 'event', ref: 'b' },
    withinMs,
  },
  partitionBy: [],
  selection: {
    overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100,
  },
  execution: {
    maxCandidates: 512,
    maxSemanticEvaluations: 0,
    maxBufferedEvents: 512,
  },
});

function random(seed) {
  let state = (Math.imul(seed, 2654435761) ^ 0x61ca76b) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function occurrence(ref, seed, index) {
  return {
    clauseId: ref,
    traceId: 'finality:' + seed + ':' + index,
    sourceEventId: 'finality:' + seed + ':' + index,
    eventName: ref + '.event',
    occurredAt: new Date(epoch + index * 200).toISOString(),
    provider: 'synthetic',
    serverId: 'finality-oracle',
    subscriptionArguments: {},
    data: {},
  };
}

function ids(candidates) {
  return candidates.map(item =>
    item.bindings.a?.[0]?.sourceEventId).sort();
}

function assertedMonotonic(previousMatches, currentMatches, context) {
  for (const id of previousMatches) {
    assert.ok(currentMatches.includes(id), context + ': finalized match reversed: ' + id);
  }
}

test('finite frozen negative windows never regress from terminal to pending across clock advances', {
  timeout: 60000,
}, async () => {
  let witnessedPendingToMatch = 0;
  let witnessedBlocked = 0;
  const differentOrders = new Set();

  for (let seed = 1; seed <= 64; seed++) {
    const rand = random(seed);
    const count = 1 + ((seed - 1) % 8);
    const events = Array.from({ length: count }, (_, index) =>
      occurrence(index === 0 ? 'a' :
        ['a', 'b', 'noise'][Math.floor(rand() * 3)], seed, index));
    const anchors = events.filter(item => item.clauseId === 'a');
    const clocks = [...new Set([
      epoch - 1,
      epoch,
      ...anchors.flatMap(item => {
        const boundary = Date.parse(item.occurredAt) + withinMs + allowedLatenessMs;
        return [boundary - 1, boundary, boundary + 1];
      }),
      epoch + 3600,
    ])].sort((a, b) => a - b);
    const rotations = [
      [...events],
      [...events].reverse(),
      [...events.slice(1), events[0]],
    ];
    for (const [round, delivery] of rotations.entries()) {
      differentOrders.add(delivery.map(item => item.sourceEventId).join(','));
      let lastMatches = [];
      let lastPending = [];
      for (const nowMs of clocks) {
        const reference = referenceNotFollowedBy(events, {
          withinMs, allowedLatenessMs, nowMs,
        });
        const actual = await evaluatePatternV2({
          definition, events: delivery, now: new Date(nowMs), allowedLatenessMs,
        });
        const context = 'seed=' + seed + '/round=' + round + '/clock=' + nowMs;
        assert.equal(actual.truncated, false, context);
        const obtained = {
          matches: ids(actual.matches),
          pending: ids(actual.pending),
        };
        assert.deepEqual(obtained, reference, context);
        assertedMonotonic(lastMatches, obtained.matches, context);
        for (const id of obtained.pending) {
          assert.equal(lastMatches.includes(id), false,
            context + ': terminal candidate returned to pending');
        }
        witnessedPendingToMatch += obtained.matches.filter(id =>
          lastPending.includes(id)).length;
        lastMatches = obtained.matches;
        lastPending = obtained.pending;
      }
      const blockedIds = anchors.map(item => item.sourceEventId)
        .filter(id => !lastMatches.includes(id));
      witnessedBlocked += blockedIds.length;
      assert.deepEqual(lastPending, [],
        'all finite windows must be resolved by final synthetic clock');
    }
  }
  assert.ok(differentOrders.size > 64,
    'fixtures must exercise multiple arrival permutations');
  assert.ok(witnessedPendingToMatch > 0,
    'there must be witnessed pending-to-terminal transitions');
  assert.ok(witnessedBlocked > 0,
    'there must be forbidden-event counterexamples');
});

test('monotonicity guard is mutation-sensitive to a dropped finalized match', () => {
  assert.throws(() => assertedMonotonic(
    ['already-final'], [], 'deliberate-mutation'), /finalized match reversed/);
});
