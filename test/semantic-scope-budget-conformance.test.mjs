import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PatternAstV2DefinitionSchema, evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

function semanticPattern(maxCalls, onUnavailable = 'reject') {
  return PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: {
      kind: 'semantic',
      id: 'meaningful-update',
      refs: ['issue'],
      instruction: 'Is this update substantive?',
      input: ['issue.title'],
      matchThreshold: 0.8,
      rejectThreshold: 0.2,
      uncertain: 'reject',
      execution: {
        cache: true,
        timeoutMs: 1000,
        onUnavailable,
      },
      child: { kind: 'event', ref: 'issue' },
    },
    partitionBy: [],
    selection: {
      overlap: 'allow',
      afterMatch: 'keepAll',
      maxMatchesPerEvent: 100,
    },
    execution: {
      maxCandidates: 64,
      maxSemanticEvaluations: maxCalls,
      maxBufferedEvents: 64,
    },
  });
}

function events(count = 1, tenantLabel = 'tenant-a') {
  return Array.from({ length: count }, (_, i) => ({
    clauseId: 'issue',
    traceId: tenantLabel + ':trace:' + i,
    sourceEventId: 'issue-' + i,
    eventName: 'github.issue.updated',
    serverId: 'github-events',
    provider: 'synthetic',
    occurredAt: new Date(Date.UTC(2026, 9, 10, 12, 0, i)).toISOString(),
    subscriptionArguments: {},
    data: { title: 'Synthetic change ' + i },
  }));
}

test('semantic importance gate never exceeds the canonical per-evaluation call budget', async () => {
  let calls = 0;
  const evaluator = {
    cacheIdentity: 'fixture/evaluator:v1',
    async evaluate() {
      calls++;
      return { evaluator: 'fixture/v1', probability: 0.9 };
    },
  };
  const result = await evaluatePatternV2({
    definition: semanticPattern(2),
    events: events(6),
    evaluator,
    now: new Date('2026-10-10T12:20:00.000Z'),
  });
  assert.equal(calls, 2);
  assert.equal(result.semanticEvaluations, 2);
  assert.equal(result.truncated, true,
    'budget exhaustion must not be reported as an ordinary no-match');
  assert.ok(result.matches.length <= 2);
});

test('durable semantic decision keys do not cross tenant scope, evaluator or trigger revision', async () => {
  const entries = new Map();
  const cache = {
    get: key => entries.get(key) ?? null,
    set: (key, value) => entries.set(key, value),
  };
  let calls = 0;
  const evaluator = {
    cacheIdentity: 'fixture/model:v1',
    async evaluate() {
      calls++;
      return { evaluator: 'fixture/model', probability: 0.95 };
    },
  };
  const check = async (namespace, sourceEvents = events(1), model = evaluator) =>
    evaluatePatternV2({
      definition: semanticPattern(3),
      events: sourceEvents,
      evaluator: model,
      semanticCache: cache,
      semanticCacheNamespace: namespace,
    });
  await check('tenant-a:trigger@1');
  assert.equal(calls, 1);
  const cached = await check('tenant-a:trigger@1');
  assert.equal(cached.semanticCacheHits, 1);
  assert.equal(calls, 1);
  await check('tenant-b:trigger@1');
  assert.equal(calls, 2, 'a distinct tenant namespace must not reuse a decision');
  await check('tenant-a:trigger@2');
  assert.equal(calls, 3, 'a changed trigger revision must evaluate again');
  await check('tenant-a:trigger@1', events(1, 'tenant-a'), {
    cacheIdentity: 'fixture/model:v2',
    async evaluate() {
      calls++;
      return { evaluator: 'fixture/model-v2', probability: 0.95 };
    },
  });
  assert.equal(calls, 4, 'new evaluator identity must invalidate decisions');
  assert.equal(entries.size, 4);
});

test('an unavailable semantic evaluator cannot invent importance judgments', async () => {
  const result = await evaluatePatternV2({
    definition: semanticPattern(2, 'reject'),
    events: events(1),
    evaluator: null,
  });
  assert.equal(result.matches.length, 0);
  assert.equal(result.semanticEvaluations, 0);
  assert.equal(result.truncated, false);
  const deterministic = PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: { kind: 'event', ref: 'issue' },
    partitionBy: [],
    selection: { overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 100 },
    execution: { maxCandidates: 64, maxSemanticEvaluations: 0, maxBufferedEvents: 64 },
  });
  const structural = await evaluatePatternV2({
    definition: deterministic,
    events: events(1),
    evaluator: null,
  });
  assert.equal(structural.matches.length, 1,
    'deterministic Pattern matching does not require a semantic model');
});
