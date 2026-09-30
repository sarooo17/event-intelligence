import assert from 'node:assert/strict';
import {
  PatternAstV2DefinitionSchema,
  compileLegacyTriggerToPatternV2,
  evaluatePatternV2,
} from '../../dist/src/intelligenceProtocol/index.js';

function event(ref, id, at, data = {}) {
  return {
    clauseId: ref,
    traceId: `conf-${id}`,
    sourceEventId: id,
    eventName: `${ref}.event`,
    occurredAt: at,
    provider: 'conformance',
    serverId: 'conformance',
    subscriptionArguments: {},
    data,
  };
}

function pattern(root, extra = {}) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root,
    partitionBy: extra.partitionBy ?? [],
    selection: extra.selection ?? {
      overlap: 'allow',
      afterMatch: 'keepAll',
      maxMatchesPerEvent: 100,
    },
    execution: extra.execution ?? {
      maxCandidates: 2048,
      maxSemanticEvaluations: 8,
      maxBufferedEvents: 10000,
    },
  });
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffle(values, random) {
  const output = [...values];
  for (let i = output.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}

const checks = [];
async function check(name, fn) {
  const started = performance.now();
  await fn();
  checks.push({ name, ok: true, durationMs: performance.now() - started });
}

await check('event-time order is delivery-order invariant for followedBy', async () => {
  const definition = pattern({
    kind: 'sequence',
    contiguity: 'followedBy',
    children: [
      { kind: 'event', ref: 'a' },
      { kind: 'event', ref: 'b' },
    ],
  });
  const source = [
    event('a', 'a1', '2026-09-30T10:00:00.000Z'),
    event('b', 'b1', '2026-09-30T10:01:00.000Z'),
    event('a', 'a2', '2026-09-30T10:02:00.000Z'),
    event('b', 'b2', '2026-09-30T10:03:00.000Z'),
  ];
  const expected = await evaluatePatternV2({ definition, events: source });
  const expectedIds = expected.matches.map((candidate) =>
    candidate.events.map((item) => item.sourceEventId).join(','));

  for (let seed = 1; seed <= 50; seed += 1) {
    const result = await evaluatePatternV2({
      definition,
      events: shuffle(source, seeded(seed)),
    });
    assert.deepEqual(
      result.matches.map((candidate) =>
        candidate.events.map((item) => item.sourceEventId).join(',')),
      expectedIds,
    );
  }
});

await check('candidate budget bounds combinations', async () => {
  const definition = pattern({
    kind: 'repeat',
    child: { kind: 'event', ref: 'x' },
    min: 3,
    max: 8,
    mode: 'greedy',
    contiguity: 'combinations',
  }, {
    execution: {
      maxCandidates: 64,
      maxSemanticEvaluations: 0,
      maxBufferedEvents: 1000,
    },
  });
  const events = Array.from({ length: 20 }, (_, i) =>
    event('x', `x-${i}`, new Date(Date.UTC(2026, 8, 30, 10, 0, i)).toISOString()));
  const result = await evaluatePatternV2({ definition, events });
  assert.equal(result.truncated, true);
  assert.ok(result.matches.length <= 64);
});

await check('negative pattern waits through allowed lateness', async () => {
  const definition = pattern({
    kind: 'notFollowedBy',
    id: 'quiet',
    child: { kind: 'event', ref: 'deploy' },
    forbidden: { kind: 'event', ref: 'error' },
    withinMs: 60_000,
  });
  const events = [
    event('deploy', 'deploy-1', '2026-09-30T10:00:00.000Z'),
  ];
  const pending = await evaluatePatternV2({
    definition,
    events,
    allowedLatenessMs: 30_000,
    now: new Date('2026-09-30T10:01:10.000Z'),
  });
  assert.equal(pending.matches.length, 0);
  assert.equal(pending.pending.length, 1);

  const forbidden = await evaluatePatternV2({
    definition,
    events: [
      ...events,
      event('error', 'error-1', '2026-09-30T10:00:30.000Z'),
    ],
    allowedLatenessMs: 30_000,
    now: new Date('2026-09-30T10:01:10.000Z'),
  });
  assert.equal(forbidden.matches.length, 0);
  assert.equal(forbidden.pending.length, 0);
});

await check('semantic node is explicit and budgeted', async () => {
  let calls = 0;
  const evaluator = {
    async evaluate() {
      calls += 1;
      return {
        evaluator: 'conformance/fake',
        probability: 0.95,
        matched: true,
        rejected: false,
        uncertain: false,
        metadata: {},
      };
    },
  };
  const definition = pattern({
    kind: 'semantic',
    id: 'same-problem',
    refs: ['issue', 'mail'],
    instruction: 'Same underlying problem?',
    input: ['issue.title', 'mail.subject'],
    matchThreshold: 0.8,
    rejectThreshold: 0.2,
    uncertain: 'escalate',
    execution: {
      cache: true,
      timeoutMs: 1000,
      onUnavailable: 'error',
    },
    child: {
      kind: 'allOf',
      children: [
        { kind: 'event', ref: 'issue' },
        { kind: 'event', ref: 'mail' },
      ],
    },
  }, {
    execution: {
      maxCandidates: 128,
      maxSemanticEvaluations: 1,
      maxBufferedEvents: 1000,
    },
  });
  const result = await evaluatePatternV2({
    definition,
    evaluator,
    events: [
      event('issue', 'issue-1', '2026-09-30T10:00:00.000Z', {
        title: 'Payment failed',
      }),
      event('mail', 'mail-1', '2026-09-30T10:01:00.000Z', {
        subject: 'Payment failed again',
      }),
    ],
  });
  assert.equal(result.matches.length, 1);
  assert.equal(calls, 1);
  assert.equal(result.semanticEvaluations, 1);
});

await check('legacy compiler preserves representative sequence semantics', async () => {
  const compiled = compileLegacyTriggerToPatternV2({
    protocolVersion: '0.1.0',
    schemaVersion: 'trigger.v0.1',
    triggerId: 'legacy-sequence',
    version: '1',
    clauses: [
      { id: 'a', event: 'a.event', arguments: {}, where: [] },
      { id: 'b', event: 'b.event', arguments: {}, where: [] },
    ],
    expression: { kind: 'sequence', refs: ['a', 'b'] },
    temporal: [],
    lifecycle: {
      oneShot: false,
      cooldownMs: 0,
      completeOnGoal: false,
    },
    withinMs: 60_000,
    conditionOnly: true,
  });
  const result = await evaluatePatternV2({
    definition: compiled,
    events: [
      event('a', 'legacy-a', '2026-09-30T10:00:00.000Z'),
      event('b', 'legacy-b', '2026-09-30T10:00:30.000Z'),
    ],
  });
  assert.equal(result.matches.length, 1);
});

console.log(JSON.stringify({
  schema: 'event-intelligence.pattern-v2-conformance.v1',
  generatedAt: new Date().toISOString(),
  checks,
  passed: checks.length,
}, null, 2));
