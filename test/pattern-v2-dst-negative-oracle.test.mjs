import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema,
  evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';
import { referenceNotFollowedBy } from '../scripts/evidence/reference-negation-oracle.mjs';

// Explicit offsets deliberately straddle real Europe/Rome 2026 clock changes.
// The oracle uses numeric epoch times, never local-hour subtraction.
const transitions = [
  {
    name: 'spring-forward',
    anchor: '2026-03-29T01:59:59.500+01:00',
    next: '2026-03-29T03:00:00.000+02:00',
  },
  {
    name: 'fall-back repeated hour',
    anchor: '2026-10-25T02:59:59.500+02:00',
    next: '2026-10-25T02:00:00.000+01:00',
  },
];
const withinMs = 1000;
const allowedLatenessMs = 350;

const definition = PatternAstV2DefinitionSchema.parse({
  version: '2',
  root: {
    kind: 'notFollowedBy',
    id: 'no-forbidden-after-anchor',
    child: { kind: 'event', ref: 'a' },
    forbidden: { kind: 'event', ref: 'b' },
    withinMs,
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

function event(ref, id, occurredAt) {
  return {
    clauseId: ref,
    traceId: 'dst:' + id,
    sourceEventId: id,
    eventName: ref + '.event',
    occurredAt,
    provider: 'reference',
    serverId: 'dst-conformance',
    subscriptionArguments: {},
    data: {},
  };
}

function evidence(result) {
  const ids = values => values.map(candidate =>
    candidate.bindings.a?.[0]?.sourceEventId).sort();
  return { matches: ids(result.matches), pending: ids(result.pending) };
}

function permutations(events) {
  if (events.length < 2) return [events];
  const reverse = [...events].reverse();
  const rotate = [...events.slice(1), events[0]];
  return [events, reverse, rotate];
}

for (const transition of transitions) {
  test('negative finality uses absolute instants at ' + transition.name, async () => {
    const t0 = Date.parse(transition.anchor);
    const t1 = Date.parse(transition.next);
    assert.equal(t1 - t0, 500,
      'the physically next occurrence is only 500ms after the anchor');

    // Mutation control: stripping the explicit offsets makes a naive
    // wall-clock implementation miss the correct ordering/window.
    const localAsUtc = iso =>
      Date.parse(iso.slice(0, 23) + 'Z');
    const wrongDelta = localAsUtc(transition.next) -
      localAsUtc(transition.anchor);
    assert.notEqual(wrongDelta, 500,
      'wall-time arithmetic must disagree with the correct instant delta');
    assert.equal(Math.abs(wrongDelta - 500), 3_600_000);

    const anchor = event('a', transition.name + ':a', transition.anchor);
    const noise = event('noise', transition.name + ':noise',
      new Date(t0 + 250).toISOString());
    const crossesDst = event('b', transition.name + ':b', transition.next);
    const deadline = event('b', transition.name + ':boundary',
      new Date(t0 + withinMs).toISOString());
    const afterDeadline = event('b', transition.name + ':after',
      new Date(t0 + withinMs + 1).toISOString());

    const cases = [
      { name: 'absence', events: [anchor, noise], shouldBlock: false },
      { name: 'crosses-transition', events: [anchor, noise, crossesDst], shouldBlock: true },
      { name: 'at-deadline', events: [anchor, noise, deadline], shouldBlock: true },
      { name: 'after-deadline', events: [anchor, noise, afterDeadline], shouldBlock: false },
    ];
    const finalAt = t0 + withinMs + allowedLatenessMs;
    for (const sample of cases) {
      for (const nowMs of [finalAt - 1, finalAt]) {
        const expected = referenceNotFollowedBy(sample.events, {
          withinMs, allowedLatenessMs, nowMs,
        });
        assert.deepEqual(expected, {
          matches: !sample.shouldBlock && nowMs === finalAt
            ? [anchor.sourceEventId] : [],
          pending: !sample.shouldBlock && nowMs < finalAt
            ? [anchor.sourceEventId] : [],
        });
        for (const [round, delivery] of permutations(sample.events).entries()) {
          const actual = await evaluatePatternV2({
            definition,
            events: delivery,
            now: new Date(nowMs),
            allowedLatenessMs,
          });
          assert.equal(actual.truncated, false,
            transition.name + '/' + sample.name + '/' + round);
          assert.deepEqual(evidence(actual), expected,
            transition.name + '/' + sample.name +
            '/' + round + '/time=' + nowMs);
        }
      }
    }
  });

  test('reference model rejects ambiguous local time at ' + transition.name, () => {
    const anchor = event('a', transition.name + ':invalid',
      transition.anchor.slice(0, 23));
    assert.throws(
      () => referenceNotFollowedBy([anchor], {
        withinMs, allowedLatenessMs,
        nowMs: Date.parse(transition.next),
      }),
      /unique valid a\/b\/noise events/,
      'offset-free repeated/spring-forward local times are outside the reference domain',
    );
  });
}
