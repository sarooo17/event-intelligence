import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema,
  evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

function definition({ onUnavailable = 'error', uncertain = 'escalate', timeoutMs = 20 } = {}) {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: {
      kind: 'semantic',
      id: 'same-incident',
      refs: ['issue', 'mail'],
      instruction: 'Do the two updates concern the same incident?',
      input: ['issue.title', 'mail.subject'],
      matchThreshold: 0.8,
      rejectThreshold: 0.2,
      uncertain,
      execution: { cache: true, timeoutMs, onUnavailable },
      child: {
        kind: 'window',
        window: { type: 'within', sizeMs: 90_000 },
        child: {
          kind: 'allOf',
          children: [
            { kind: 'event', ref: 'issue' },
            { kind: 'event', ref: 'mail' },
          ],
        },
      },
    },
    partitionBy: [],
    selection: { overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100 },
    execution: {
      maxCandidates: 32,
      maxSemanticEvaluations: 1,
      maxBufferedEvents: 32,
    },
  });
}

const source = [
  {
    clauseId: 'issue',
    traceId: 'semantic-error:issue',
    sourceEventId: 'issue-1',
    eventName: 'github.issue.updated',
    occurredAt: '2026-10-14T10:00:00.000Z',
    provider: 'fixture',
    serverId: 'github',
    subscriptionArguments: {},
    data: { title: 'Billing outage' },
  },
  {
    clauseId: 'mail',
    traceId: 'semantic-error:mail',
    sourceEventId: 'mail-1',
    eventName: 'mail.received',
    occurredAt: '2026-10-14T10:00:30.000Z',
    provider: 'fixture',
    serverId: 'mail',
    subscriptionArguments: {},
    data: { subject: 'Billing outage persists' },
  },
];

function run(opts = {}) {
  const { events = source, evaluator = null, cache = null, namespace = '', ...schema } = opts;
  return evaluatePatternV2({
    definition: definition(schema),
    events,
    evaluator,
    semanticCache: cache,
    semanticCacheNamespace: namespace,
    now: new Date('2026-10-14T10:03:00.000Z'),
  });
}

function model(probability) {
  return {
    cacheIdentity: 'conformance/semantic-failure:v1',
    async evaluate(input) {
      assert.deepEqual(input.input, {
        'issue.title': 'Billing outage',
        'mail.subject': 'Billing outage persists',
      });
      return { evaluator: 'conformance/semantic-failure:v1', probability };
    },
  };
}

test('explicit semantic decisions preserve match, reject and uncertain policy', async () => {
  for (const [probability, uncertain, matched, outcome] of [
    [0.8, 'escalate', true, 'match'],
    [0.2, 'escalate', false, 'reject'],
    [0.5, 'escalate', false, 'uncertain'],
    [0.5, 'reject', false, 'uncertain'],
    [0.5, 'match', true, 'uncertain'],
  ]) {
    for (const events of [source, [...source].reverse()]) {
      const output = await run({ events, evaluator: model(probability), uncertain });
      assert.equal(output.truncated, false);
      assert.equal(output.pending.length, 0);
      assert.equal(output.matches.length, Number(matched));
      assert.equal(output.semanticEvaluations, 1);
      assert.equal(output.semanticTrace.length, 1);
      assert.equal(output.semanticTrace[0].decision.outcome, outcome);
      assert.equal(output.semanticTrace[0].decision.shouldEscalate,
        outcome === 'uncertain' && uncertain === 'escalate');
      if (matched) {
        assert.deepEqual(
          output.matches[0].events.map(ev => ev.sourceEventId),
          ['issue-1', 'mail-1'],
        );
      }
    }
  }
});

test('missing evaluator is fail-closed by default; explicit reject policy is an opt-in', async () => {
  await assert.rejects(
    run({ onUnavailable: 'error' }),
    /Semantic node same-incident requires a SemanticEvaluator/,
  );
  const explicitReject = await run({ onUnavailable: 'reject' });
  assert.deepEqual(explicitReject.matches, []);
  assert.deepEqual(explicitReject.pending, []);
  assert.equal(explicitReject.truncated, false);
  assert.equal(explicitReject.semanticEvaluations, 0);
  assert.deepEqual(explicitReject.semanticTrace, []);
});

test('provider throws or returns invalid probability: error propagates under both policies', async () => {
  for (const onUnavailable of ['error', 'reject']) {
    await assert.rejects(
      run({ onUnavailable, evaluator: {
        async evaluate() { throw new Error('fixture-provider-outage'); },
      } }),
      /fixture-provider-outage/,
      'onUnavailable=' + onUnavailable + ' cannot mask provider exceptions',
    );
    for (const probability of [NaN, Infinity, -0.01, 1.01]) {
      await assert.rejects(
        run({ onUnavailable, evaluator: model(probability) }),
        /Semantic evaluator probability must be between 0 and 1/,
        'onUnavailable=' + onUnavailable + ' cannot mask invalid response scores',
      );
    }
  }
});

test('timeout rejects and cannot persist or reuse a failed semantic decision', {
  timeout: 5000,
}, async () => {
  const entries = new Map();
  let reads = 0;
  let writes = 0;
  const cache = {
    get: key => { reads++; return entries.get(key) ?? null; },
    set: (key, decision) => { writes++; entries.set(key, decision); },
  };
  const namespace = 'tenant-fixture:trigger@1';
  const pendingModel = {
    cacheIdentity: 'conformance/semantic-failure:v1',
    async evaluate() { return new Promise(() => {}); },
  };
  await assert.rejects(
    run({ evaluator: pendingModel, cache, namespace, timeoutMs: 20 }),
    /Semantic node same-incident timed out after 20ms/,
  );
  assert.equal(writes, 0, 'timed-out semantic evaluation cannot poison durable cache');
  assert.equal(entries.size, 0);

  const retried = await run({
    evaluator: model(0.95), cache, namespace, timeoutMs: 20,
  });
  assert.equal(retried.matches.length, 1);
  assert.equal(retried.semanticEvaluations, 1,
    'failed evaluation must be retried, not treated as a cached negative');
  assert.equal(writes, 1);
  assert.ok(reads >= 2);
  const warm = await run({
    evaluator: model(0.95), cache, namespace, timeoutMs: 20,
  });
  assert.equal(warm.semanticEvaluations, 0);
  assert.equal(warm.semanticCacheHits, 1);
  assert.equal(writes, 1);
});

test('reject-on-unavailable cannot convert a configured provider timeout to no-match', {
  timeout: 5000,
}, async () => {
  for (const onUnavailable of ['error', 'reject']) {
    await assert.rejects(
      run({
        onUnavailable,
        timeoutMs: 20,
        evaluator: {
          async evaluate() { return new Promise(() => {}); },
        },
      }),
      /Semantic node same-incident timed out after 20ms/,
      'configured provider timeout must reject under policy=' + onUnavailable,
    );
  }
});

test('structurally impossible pair never invokes semantic evaluator', async () => {
  let calls = 0;
  const output = await run({
    events: [source[0], {
      ...source[1],
      occurredAt: '2026-10-14T10:05:00.000Z',
    }],
    evaluator: {
      async evaluate() { calls++; throw new Error('must not be called'); },
    },
  });
  assert.equal(calls, 0);
  assert.equal(output.truncated, false);
  assert.deepEqual(output.matches, []);
  assert.deepEqual(output.semanticTrace, []);
});
