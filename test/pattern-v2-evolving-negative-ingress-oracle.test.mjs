import assert from 'node:assert/strict';
import test from 'node:test';
import { PatternAstV2DefinitionSchema, evaluatePatternV2 }
  from '../dist/src/intelligenceProtocol/index.js';
import { referenceNotFollowedBy }
  from '../scripts/evidence/reference-negation-oracle.mjs';

const withinMs = 400;
const allowedLatenessMs = 250;
const definition = PatternAstV2DefinitionSchema.parse({
  version: '2',
  root: {
    kind: 'notFollowedBy', id: 'no-late-b',
    child: { kind: 'event', ref: 'a' },
    forbidden: { kind: 'event', ref: 'b' }, withinMs,
  },
  partitionBy: [],
  selection: { overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100 },
  execution: { maxCandidates: 128, maxSemanticEvaluations: 0, maxBufferedEvents: 128 },
});

function occurrence(ref, id, ms) {
  return {
    clauseId: ref, traceId: 'evolving:' + id,
    sourceEventId: id, eventName: ref + '.event',
    occurredAt: new Date(ms).toISOString(), provider: 'fixture',
    serverId: 'reference', subscriptionArguments: {}, data: {},
  };
}
function provenance(candidates) {
  return candidates.map(c => c.bindings.a?.[0]?.sourceEventId).sort();
}
async function compare(corpus, nowMs, label) {
  const expected = referenceNotFollowedBy(corpus, {
    withinMs, allowedLatenessMs, nowMs,
  });
  const variants = [
    corpus,
    [...corpus].reverse(),
    [...corpus.slice(1), corpus[0]],
  ];
  for (const [round, events] of variants.entries()) {
    const actual = await evaluatePatternV2({
      definition, events,
      now: new Date(nowMs),
      allowedLatenessMs,
    });
    assert.equal(actual.truncated, false, label + '/round=' + round);
    assert.deepEqual({
      matches: provenance(actual.matches),
      pending: provenance(actual.pending),
    },expected,label + '/round=' + round);
  }
  return expected;
}

test('late negative evidence is distinguished from genuine absence across evolving corpora', {
  timeout: 60000,
},async () => {
  for (let seed=1; seed<=80; seed++) {
    const t0 = Date.UTC(2026,9,14,12,0,0)+seed*10000;
    const finalAt = t0 + withinMs + allowedLatenessMs;
    const anchor = occurrence('a','seed-'+seed+':a',t0);
    const noise = occurrence('noise','seed-'+seed+':noise',t0+3+(seed%91));
    const inside = occurrence('b','seed-'+seed+':inside',
      t0+[1,200,withinMs][seed%3]);
    const outside = occurrence('b','seed-'+seed+':outside',t0+withinMs+1);
    const noForbidden=[anchor,noise];

    const before=await compare(noForbidden,finalAt-1,'seed='+seed+'/before');
    assert.deepEqual(before.matches,[]);
    assert.deepEqual(before.pending,[anchor.sourceEventId]);
    const complete=await compare(noForbidden,finalAt,'seed='+seed+'/complete');
    assert.deepEqual(complete.matches,[anchor.sourceEventId]);
    assert.deepEqual(complete.pending,[]);

    // A source event that arrives late in processing order, but is still
    // inside the event-time window, cancels an otherwise pending result.
    const withLate=[anchor,noise,inside];
    for(const nowMs of [finalAt-1,finalAt]) {
      const blocked=await compare(withLate,nowMs,
        'seed='+seed+'/late-event/clock='+nowMs);
      assert.deepEqual(blocked,{matches:[],pending:[]});
    }
    // Strict event-time deadline: even a 1ms later forbidden source does
    // not cancel the anchored negative result.
    const beyond=await compare([anchor,noise,outside],finalAt,
      'seed='+seed+'/outside');
    assert.deepEqual(beyond.matches,[anchor.sourceEventId]);
    assert.deepEqual(beyond.pending,[]);
    const afterFinality=await compare(withLate,finalAt+1,
      'seed='+seed+'/after-finality/late-ingress');
    assert.deepEqual(afterFinality,{matches:[],pending:[]});
    // The finality result was derived from a DIFFERENT input collection.
    // This exposes the need for a host watermark/late-data policy: it is
    // not a monotonic guarantee over inputs that change after finality.
    assert.notDeepEqual(afterFinality,complete);
  }
});

test('deadline mutation probe rejects equality vs deadline + 1ms confusion', async () => {
  const t0=Date.UTC(2026,9,14,12,0,0);
  const anchor=occurrence('a','anchor',t0);
  const onDeadline=occurrence('b','on-deadline',t0+withinMs);
  const justAfter=occurrence('b','just-after',t0+withinMs+1);
  const now=t0+withinMs+allowedLatenessMs;
  const blocked=await compare([anchor,onDeadline],now,'inclusive-deadline');
  const clear=await compare([anchor,justAfter],now,'after-deadline');
  assert.deepEqual(blocked.matches,[]);
  assert.deepEqual(clear.matches,[anchor.sourceEventId]);
});
