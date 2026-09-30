import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PatternAstV2DefinitionSchema,
  StructuredPredicateSchema,
  compileLegacyTriggerToPatternV2,
  evaluatePatternMeasure,
  evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { clauseMatches } from '../dist/src/composite/matching.js';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TriggerControlPlane } from '../scripts/lib/trigger-control-plane.mjs';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import { DerivedEventCoordinator } from '../scripts/lib/derived-event-coordinator.mjs';

function source(ref, id, at, data = {}, extra = {}) {
  return {
    clauseId: ref,
    traceId: `trace-${id}`,
    sourceEventId: id,
    eventName: extra.eventName ?? `${ref}.event`,
    occurredAt: at,
    provider: 'test',
    serverId: extra.serverId ?? 'test-server',
    subscriptionArguments: {},
    data,
  };
}

function correlatable(id, name, at, data = {}, extra = {}) {
  return {
    traceId: `trace-${id}`,
    sourceEventId: id,
    name,
    occurredAt: at,
    provider: 'test',
    serverId: extra.serverId ?? 'test-server',
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
      overlap: 'disallow',
      afterMatch: 'skipPastLast',
      maxMatchesPerEvent: 10,
    },
    execution: extra.execution ?? {
      maxCandidates: 512,
      maxSemanticEvaluations: 16,
    },
  });
}

test('advanced event predicates validate and execute', () => {
  const event = correlatable(
    'predicate',
    'message.received',
    '2026-09-30T10:00:00.000Z',
    {
      subject: 'URGENT: invoice-123.pdf',
      amount: 2500,
      closedAt: null,
      tags: ['finance', 'vip'],
    },
  );

  const predicates = [
    { path: 'subject', op: 'startsWith', value: 'URGENT:' },
    { path: 'subject', op: 'endsWith', value: '.pdf' },
    { path: 'subject', op: 'regex', value: 'invoice-[0-9]+\\.pdf$' },
    { path: 'amount', op: 'between', value: [1000, 5000] },
    { path: 'amount', op: 'notIn', value: [1, 2, 3] },
    { path: 'closedAt', op: 'isNull', value: true },
    { path: 'tags', op: 'type', value: 'array' },
  ];

  for (const predicate of predicates) {
    StructuredPredicateSchema.parse(predicate);
  }

  assert.equal(
    clauseMatches(
      {
        id: 'message',
        event: 'message.received',
        arguments: {},
        where: predicates,
      },
      event,
    ),
    true,
  );
});

test('nested repeat + aggregate + window produces a greedy CEP match', async () => {
  const definition = pattern({
    kind: 'aggregate',
    function: 'sum',
    ref: 'order',
    path: 'total',
    op: 'gte',
    value: 600,
    child: {
      kind: 'window',
      window: { type: 'within', sizeMs: 10 * 60 * 1000 },
      child: {
        kind: 'repeat',
        child: { kind: 'event', ref: 'order' },
        min: 2,
        max: 3,
        mode: 'greedy',
      },
    },
  });

  const result = await evaluatePatternV2({
    definition,
    now: new Date('2026-09-30T10:06:00.000Z'),
    events: [
      source('order', 'o1', '2026-09-30T10:00:00.000Z', { total: 100 }),
      source('order', 'o2', '2026-09-30T10:02:00.000Z', { total: 200 }),
      source('order', 'o3', '2026-09-30T10:04:00.000Z', { total: 300 }),
    ],
  });

  assert.ok(result.matches.length >= 1);
  assert.equal(result.matches[0].bindings.order.length, 3);
  assert.equal(
    evaluatePatternMeasure(result.matches[0], {
      key: 'sum',
      expression: {
        kind: 'aggregate',
        function: 'sum',
        ref: 'order',
        path: 'total',
      },
    }),
    600,
  );
});

test('sequence contiguity distinguishes next from followedBy', async () => {
  const events = [
    source('a', 'a1', '2026-09-30T10:00:00.000Z'),
    source('noise', 'n1', '2026-09-30T10:01:00.000Z'),
    source('b', 'b1', '2026-09-30T10:02:00.000Z'),
  ];

  const next = await evaluatePatternV2({
    definition: pattern({
      kind: 'sequence',
      contiguity: 'next',
      children: [
        { kind: 'event', ref: 'a' },
        { kind: 'event', ref: 'b' },
      ],
    }),
    events,
  });
  assert.equal(next.matches.length, 0);

  const followed = await evaluatePatternV2({
    definition: pattern({
      kind: 'sequence',
      contiguity: 'followedBy',
      children: [
        { kind: 'event', ref: 'a' },
        { kind: 'event', ref: 'b' },
      ],
    }),
    events,
  });
  assert.equal(followed.matches.length, 1);
});

test('cross-event arithmetic compare and state operators are deterministic', async () => {
  const events = [
    source('status', 's1', '2026-09-30T10:00:00.000Z', {
      status: 'draft',
      score: 9,
    }),
    source('status', 's2', '2026-09-30T10:03:00.000Z', {
      status: 'paid',
      score: 11,
    }),
  ];

  const statePattern = pattern({
    kind: 'state',
    ref: 'status',
    path: 'status',
    op: 'changedFrom',
    from: 'draft',
    to: 'paid',
    child: {
      kind: 'repeat',
      child: { kind: 'event', ref: 'status' },
      min: 2,
      max: 2,
      mode: 'greedy',
    },
  });
  const stateResult = await evaluatePatternV2({
    definition: statePattern,
    events,
  });
  assert.equal(stateResult.matches.length, 1);

  const comparePattern = pattern({
    kind: 'compare',
    child: {
      kind: 'repeat',
      child: { kind: 'event', ref: 'status' },
      min: 2,
      max: 2,
      mode: 'greedy',
    },
    left: {
      kind: 'arithmetic',
      op: 'subtract',
      args: [
        { kind: 'occurredAt', ref: 'status', select: 'last' },
        { kind: 'occurredAt', ref: 'status', select: 'first' },
      ],
    },
    op: 'lte',
    right: { kind: 'literal', value: 5 * 60 * 1000 },
  });
  const compareResult = await evaluatePatternV2({
    definition: comparePattern,
    events,
  });
  assert.equal(compareResult.matches.length, 1);

  const crossing = pattern({
    kind: 'state',
    ref: 'status',
    path: 'score',
    op: 'crossesAbove',
    value: 10,
    child: {
      kind: 'repeat',
      child: { kind: 'event', ref: 'status' },
      min: 2,
      max: 2,
      mode: 'greedy',
    },
  });
  assert.equal(
    (await evaluatePatternV2({ definition: crossing, events })).matches.length,
    1,
  );
});

test('tumbling, hopping, session and count windows are executable', async () => {
  const events = [
    source('e', 'e1', '2026-09-30T10:00:00.000Z'),
    source('e', 'e2', '2026-09-30T10:02:00.000Z'),
    source('e', 'e3', '2026-09-30T10:04:00.000Z'),
  ];
  const repeated = {
    kind: 'repeat',
    child: { kind: 'event', ref: 'e' },
    min: 3,
    max: 3,
    mode: 'greedy',
  };

  for (const window of [
    { type: 'tumbling', sizeMs: 10 * 60 * 1000, offsetMs: 0 },
    { type: 'hopping', sizeMs: 10 * 60 * 1000, hopMs: 5 * 60 * 1000, offsetMs: 0 },
    { type: 'session', gapMs: 3 * 60 * 1000 },
    { type: 'count', size: 3 },
  ]) {
    const result = await evaluatePatternV2({
      definition: pattern({
        kind: 'window',
        window,
        child: repeated,
      }),
      events,
    });
    assert.equal(result.matches.length >= 1, true, window.type);
  }
});

test('semantic is a first-class operator behind SemanticEvaluator', async () => {
  const requests = [];
  const evaluator = {
    async evaluate(request) {
      requests.push(request);
      return {
        evaluator: 'test/semantic',
        probability: 0.95,
        metadata: { mode: 'test' },
      };
    },
  };

  const definition = pattern({
    kind: 'semantic',
    id: 'same-problem',
    refs: ['issue', 'mail'],
    instruction: 'Do these refer to the same problem?',
    input: ['issue.title', 'mail.subject'],
    matchThreshold: 0.8,
    rejectThreshold: 0.2,
    uncertain: 'escalate',
    execution: { cache: true, timeoutMs: 1000 },
    child: {
      kind: 'allOf',
      children: [
        { kind: 'event', ref: 'issue' },
        { kind: 'event', ref: 'mail' },
      ],
    },
  });

  const result = await evaluatePatternV2({
    definition,
    evaluator,
    events: [
      source('issue', 'i1', '2026-09-30T10:00:00.000Z', {
        title: 'Signup broken',
      }),
      source('mail', 'm1', '2026-09-30T10:01:00.000Z', {
        subject: 'Signup broken after verification',
      }),
    ],
  });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].semanticDecisions.length, 1);
  assert.equal(result.matches[0].semanticDecisions[0].decision.probability, 0.95);
  assert.equal(requests.length, 1);
});

test('single-stream partitioning is valid and isolated', async () => {
  const definition = PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: { kind: 'event', ref: 'metric' },
    partitionBy: [{
      key: 'host',
      fields: [{ ref: 'metric', path: 'host' }],
    }],
  });
  assert.equal(definition.partitionBy[0].fields.length, 1);
});

test('semantic rejects are retained in the evaluation trace', async () => {
  const definition = pattern({
    kind: 'semantic',
    id: 'not-related',
    refs: ['issue', 'mail'],
    instruction: 'Are these related?',
    input: ['issue.title', 'mail.subject'],
    matchThreshold: 0.8,
    rejectThreshold: 0.2,
    uncertain: 'reject',
    execution: { cache: true, timeoutMs: 1000 },
    child: {
      kind: 'allOf',
      children: [
        { kind: 'event', ref: 'issue' },
        { kind: 'event', ref: 'mail' },
      ],
    },
  });

  const result = await evaluatePatternV2({
    definition,
    evaluator: {
      async evaluate() {
        return { evaluator: 'test/reject', probability: 0.05 };
      },
    },
    events: [
      source('issue', 'i-reject', '2026-09-30T10:00:00.000Z', { title: 'A' }),
      source('mail', 'm-reject', '2026-09-30T10:01:00.000Z', { subject: 'B' }),
    ],
  });

  assert.equal(result.matches.length, 0);
  assert.equal(result.semanticTrace.length, 1);
  assert.equal(result.semanticTrace[0].decision.outcome, 'reject');
});

test('notFollowedBy uses forbidden-pattern completion time', async () => {
  const definition = pattern({
    kind: 'notFollowedBy',
    id: 'no-completed-failure-sequence',
    withinMs: 5 * 60 * 1000,
    child: { kind: 'event', ref: 'deploy' },
    forbidden: {
      kind: 'sequence',
      contiguity: 'followedBy',
      children: [
        { kind: 'event', ref: 'error_start' },
        { kind: 'event', ref: 'error_confirmed' },
      ],
    },
  });

  const result = await evaluatePatternV2({
    definition,
    now: new Date('2026-09-30T10:06:00.000Z'),
    events: [
      source('deploy', 'd1', '2026-09-30T10:00:00.000Z'),
      source('error_start', 'es1', '2026-09-30T10:02:00.000Z'),
      source('error_confirmed', 'ec1', '2026-09-30T10:07:00.000Z'),
    ],
  });

  assert.equal(result.matches.length, 1);
});

test('legacy composite definitions compile to Pattern AST v2', () => {
  const compiled = compileLegacyTriggerToPatternV2({
    protocolVersion: '0.1.0',
    schemaVersion: 'trigger.v0.1',
    triggerId: 'legacy',
    version: '1',
    clauses: [
      { id: 'deploy', event: 'deploy.succeeded', arguments: {}, where: [] },
      { id: 'error', event: 'production.error', arguments: {}, where: [] },
    ],
    expression: { kind: 'anyOf', refs: ['deploy'] },
    temporal: [{
      id: 'quiet',
      kind: 'absence',
      ref: 'error',
      afterRef: 'deploy',
      forMs: 600000,
    }],
    lifecycle: {
      oneShot: false,
      cooldownMs: 0,
      completeOnGoal: false,
    },
    withinMs: 3600000,
    target: { runtime: 'test', kind: 'task', id: 'legacy' },
  });

  assert.equal(compiled.version, '2');
  assert.equal(compiled.root.kind, 'absence');
  assert.equal(compiled.root.child.kind, 'anyOf');
});

test('legacy same-value correlation compiles to cross-event equality, not partitioning', () => {
  const compiled = compileLegacyTriggerToPatternV2({
    protocolVersion: '0.1.0',
    schemaVersion: 'trigger.v0.1',
    triggerId: 'legacy-correlation',
    version: '1',
    clauses: [
      { id: 'order', event: 'order.created', arguments: {}, where: [] },
      { id: 'payment', event: 'payment.completed', arguments: {}, where: [] },
      { id: 'notice', event: 'notice.received', arguments: {}, where: [] },
    ],
    expression: { kind: 'allOf', refs: ['order', 'payment', 'notice'] },
    temporal: [],
    correlation: {
      deterministic: {
        kind: 'same_value',
        fields: [
          { ref: 'order', path: 'customer' },
          { ref: 'payment', path: 'customer' },
        ],
      },
    },
    lifecycle: {
      oneShot: false,
      cooldownMs: 0,
      completeOnGoal: false,
    },
    withinMs: 3600000,
    target: { runtime: 'test', kind: 'task', id: 'legacy' },
  });

  assert.deepEqual(compiled.partitionBy, []);
  assert.equal(compiled.root.kind, 'compare');
  assert.equal(compiled.root.left.ref, 'order');
  assert.equal(compiled.root.right.ref, 'payment');
  assert.equal(compiled.root.child.kind, 'allOf');
});

test('Pattern AST v2 partitions durable state by business key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-pattern-v2-partition-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    await engine.register({
      triggerId: 'order-payment',
      version: '1',
      conditionOnly: true,
      clauses: [
        { id: 'order', event: 'order.created', arguments: {}, where: [] },
        { id: 'payment', event: 'payment.completed', arguments: {}, where: [] },
      ],
      expression: { kind: 'anyOf', refs: ['order', 'payment'] },
      temporal: [],
      patternV2: pattern(
        {
          kind: 'sequence',
          contiguity: 'followedBy',
          children: [
            { kind: 'event', ref: 'order' },
            { kind: 'event', ref: 'payment' },
          ],
        },
        {
          partitionBy: [{
            key: 'customer',
            fields: [
              { ref: 'order', path: 'customer' },
              { ref: 'payment', path: 'customer' },
            ],
          }],
        },
      ),
      withinMs: 3600000,
    });

    const first = await engine.ingest(correlatable(
      'o-a',
      'order.created',
      '2026-09-30T10:00:00.000Z',
      { customer: 'A' },
    ));
    assert.equal(first[0].matched, false);

    const wrong = await engine.ingest(correlatable(
      'p-b',
      'payment.completed',
      '2026-09-30T10:01:00.000Z',
      { customer: 'B' },
    ));
    assert.equal(wrong[0].matched, false);

    const right = await engine.ingest(correlatable(
      'p-a',
      'payment.completed',
      '2026-09-30T10:02:00.000Z',
      { customer: 'A' },
    ));
    assert.equal(right.some((result) => result.matched), true);
    assert.equal(
      right.find((result) => result.matched).match.sourceEvents.length,
      2,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('consumed Pattern v2 events remain replay-safe after buffer pruning', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-pattern-v2-replay-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    await engine.register({
      triggerId: 'replay-safe-sequence',
      version: '1',
      conditionOnly: true,
      clauses: [
        { id: 'a', event: 'a.event', arguments: {}, where: [] },
        { id: 'b', event: 'b.event', arguments: {}, where: [] },
      ],
      expression: { kind: 'anyOf', refs: ['a', 'b'] },
      temporal: [],
      patternV2: pattern({
        kind: 'sequence',
        contiguity: 'followedBy',
        children: [
          { kind: 'event', ref: 'a' },
          { kind: 'event', ref: 'b' },
        ],
      }),
      withinMs: 3600000,
    });

    const a = correlatable(
      'a1',
      'a.event',
      '2026-09-30T10:00:00.000Z',
    );
    await engine.ingest(a);

    const firstMatch = await engine.ingest(correlatable(
      'b1',
      'b.event',
      '2026-09-30T10:01:00.000Z',
    ));
    assert.equal(firstMatch.some((result) => result.matched), true);

    const replay = await engine.ingest(a);
    assert.equal(replay[0].matched, true);

    const laterB = await engine.ingest(correlatable(
      'b2',
      'b.event',
      '2026-09-30T10:02:00.000Z',
    ));
    assert.equal(laterB.some((result) => result.matched), false);

    const matches = store.listTriggerMatches('replay-safe-sequence')
      .filter((record) =>
        record.patternState?.role === 'match' &&
        record.status === 'matched'
      );
    assert.equal(matches.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Pattern v2 event identity includes subscription arguments', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-pattern-v2-subscription-id-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    await engine.register({
      triggerId: 'subscription-identity',
      version: '1',
      conditionOnly: true,
      clauses: [
        {
          id: 'left',
          event: 'shared.event',
          serverId: 'shared',
          arguments: { scope: 'left' },
          where: [],
        },
        {
          id: 'right',
          event: 'shared.event',
          serverId: 'shared',
          arguments: { scope: 'right' },
          where: [],
        },
      ],
      expression: { kind: 'anyOf', refs: ['left', 'right'] },
      temporal: [],
      patternV2: pattern({
        kind: 'allOf',
        children: [
          { kind: 'event', ref: 'left' },
          { kind: 'event', ref: 'right' },
        ],
      }),
      withinMs: 3600000,
    });

    await engine.ingest({
      ...correlatable(
        'same-id',
        'shared.event',
        '2026-09-30T10:00:00.000Z',
        {},
        { serverId: 'shared' },
      ),
      subscriptionArguments: { scope: 'left' },
    });

    const second = await engine.ingest({
      ...correlatable(
        'same-id',
        'shared.event',
        '2026-09-30T10:01:00.000Z',
        {},
        { serverId: 'shared' },
      ),
      subscriptionArguments: { scope: 'right' },
    });

    assert.equal(second.some((result) => result.matched), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bounded notFollowedBy survives as a durable deadline', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-pattern-v2-negative-'));
  let now = new Date('2026-09-30T10:01:00.000Z');
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(
      store,
      null,
      () => now,
    );

    await engine.register({
      triggerId: 'deploy-no-error',
      version: '1',
      conditionOnly: true,
      clauses: [
        { id: 'deploy', event: 'deploy.succeeded', arguments: {}, where: [] },
        { id: 'error', event: 'production.error', arguments: {}, where: [] },
      ],
      expression: { kind: 'anyOf', refs: ['deploy', 'error'] },
      temporal: [],
      patternV2: pattern({
        kind: 'notFollowedBy',
        id: 'quiet',
        child: { kind: 'event', ref: 'deploy' },
        forbidden: { kind: 'event', ref: 'error' },
        withinMs: 10 * 60 * 1000,
      }),
      withinMs: 3600000,
    });

    const initial = await engine.ingest(correlatable(
      'deploy-1',
      'deploy.succeeded',
      '2026-09-30T10:00:00.000Z',
    ));
    assert.equal(initial[0].matched, false);

    const pending = store.listTemporalDeadlines({
      triggerId: 'deploy-no-error',
      status: 'pending',
    });
    assert.equal(pending.length, 1);

    now = new Date('2026-09-30T10:10:00.000Z');
    const fired = await engine.ingest({
      traceId: 'timer-1',
      sourceEventId: 'timer-1',
      name: 'event-intelligence.timer.reached',
      occurredAt: now.toISOString(),
      provider: 'event-intelligence',
      serverId: 'event-intelligence',
      subscriptionArguments: {},
      data: { deadlineId: pending[0].deadlineId },
    });

    assert.equal(fired.some((result) => result.matched), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('derived events can emit aggregate Pattern v2 measures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-pattern-v2-measures-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    const control = new TriggerControlPlane({
      store,
      triggerEngine: engine,
    });
    const derived = new DerivedEventCoordinator({ store });
    const consumer = new CompositeEventConsumer({
      store,
      triggerEngine: engine,
      derivedEventCoordinator: derived,
    });

    await control.registerEventSource({
      sourceId: 'orders',
      connectionId: 'orders-connection',
      serverId: 'test-server',
      eventName: 'order.created',
      delivery: ['poll'],
      enabled: true,
      inputSchema: {},
      payloadSchema: {
        type: 'object',
        properties: {
          total: { type: 'number' },
          customer: { type: 'string' },
        },
      },
    }, {
      type: 'system',
      principal_id: 'test',
    });

    await control.createTrigger({
      definition: {
        triggerId: 'order-burst-derived',
        version: '1',
        clauses: [{
          id: 'order',
          event: 'order.created',
          serverId: 'test-server',
          arguments: {},
          where: [],
        }],
        expression: { kind: 'anyOf', refs: ['order'] },
        temporal: [],
        patternV2: pattern({
          kind: 'aggregate',
          function: 'sum',
          ref: 'order',
          path: 'total',
          op: 'gte',
          value: 300,
          child: {
            kind: 'repeat',
            child: { kind: 'event', ref: 'order' },
            min: 2,
            max: 2,
            mode: 'greedy',
          },
        }),
        withinMs: 3600000,
        derivedEvent: {
          name: 'orders.burst',
          contractVersion: '1',
          constants: { kind: 'burst' },
          projections: [],
          measures: [
            {
              key: 'totalValue',
              expression: {
                kind: 'aggregate',
                function: 'sum',
                ref: 'order',
                path: 'total',
              },
            },
            {
              key: 'orderCount',
              expression: {
                kind: 'aggregate',
                function: 'count',
                ref: 'order',
              },
            },
          ],
        },
      },
      connectionIds: ['orders-connection'],
      actor: { type: 'user', principal_id: 'user-1' },
      owner: { type: 'user', principal_id: 'user-1' },
    });

    await consumer.ingestCorrelatable(correlatable(
      'o1',
      'order.created',
      '2026-09-30T10:00:00.000Z',
      { total: 100, customer: 'A' },
    ));

    const second = await consumer.ingestCorrelatable(correlatable(
      'o2',
      'order.created',
      '2026-09-30T10:01:00.000Z',
      { total: 200, customer: 'A' },
    ));

    assert.equal(second.derivedEvents.length, 1);
    const derivedRecord = store.listDerivedEvents({
      triggerId: 'order-burst-derived',
    })[0];
    assert.equal(derivedRecord.event.data.totalValue, 300);
    assert.equal(derivedRecord.event.data.orderCount, 2);
    assert.equal(derivedRecord.event.data.kind, 'burst');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('repeat internal contiguity distinguishes consecutive relaxed and combinations', async () => {
  const events = [
    source('e', 'e1', '2026-09-30T10:00:00.000Z'),
    source('noise', 'n1', '2026-09-30T10:01:00.000Z'),
    source('e', 'e2', '2026-09-30T10:02:00.000Z'),
    source('e', 'e3', '2026-09-30T10:03:00.000Z'),
  ];

  const run = async (contiguity) =>
    evaluatePatternV2({
      definition: pattern({
        kind: 'repeat',
        child: { kind: 'event', ref: 'e' },
        min: 2,
        max: 2,
        mode: 'greedy',
        contiguity,
      }),
      events,
    });

  const consecutive = await run('consecutive');
  assert.deepEqual(
    consecutive.matches.map((candidate) =>
      candidate.bindings.e.map((event) => event.sourceEventId)
    ),
    [['e2', 'e3']],
  );

  const relaxed = await run('relaxed');
  assert.deepEqual(
    relaxed.matches.map((candidate) =>
      candidate.bindings.e.map((event) => event.sourceEventId)
    ),
    [['e1', 'e2'], ['e2', 'e3']],
  );

  const combinations = await run('combinations');
  assert.deepEqual(
    combinations.matches.map((candidate) =>
      candidate.bindings.e.map((event) => event.sourceEventId)
    ),
    [['e1', 'e2'], ['e1', 'e3'], ['e2', 'e3']],
  );
});

test('bounded negative patterns honor allowed lateness before finalizing', async () => {
  const definition = pattern({
    kind: 'notFollowedBy',
    id: 'quiet',
    child: { kind: 'event', ref: 'deploy' },
    forbidden: { kind: 'event', ref: 'error' },
    withinMs: 10 * 60 * 1000,
  });

  const events = [
    source('deploy', 'd1', '2026-09-30T10:00:00.000Z'),
  ];

  const early = await evaluatePatternV2({
    definition,
    events,
    now: new Date('2026-09-30T10:10:30.000Z'),
    allowedLatenessMs: 2 * 60 * 1000,
  });
  assert.equal(early.matches.length, 0);
  assert.equal(early.pending.length, 1);
  assert.equal(
    early.pending[0].pendingUntil,
    '2026-09-30T10:12:00.000Z',
  );

  const final = await evaluatePatternV2({
    definition,
    events,
    now: new Date('2026-09-30T10:12:00.000Z'),
    allowedLatenessMs: 2 * 60 * 1000,
  });
  assert.equal(final.matches.length, 1);

  const lateButAllowedForbidden = await evaluatePatternV2({
    definition,
    events: [
      ...events,
      source('error', 'err1', '2026-09-30T10:09:00.000Z'),
    ],
    now: new Date('2026-09-30T10:11:00.000Z'),
    allowedLatenessMs: 2 * 60 * 1000,
  });
  assert.equal(lateButAllowedForbidden.matches.length, 0);
  assert.equal(lateButAllowedForbidden.pending.length, 0);
});

test('rate windows are event-time based and stable across delayed processing', async () => {
  const definition = pattern({
    kind: 'rate',
    ref: 'order',
    atLeast: 2,
    perMs: 5 * 60 * 1000,
    child: { kind: 'event', ref: 'order' },
  });

  const result = await evaluatePatternV2({
    definition,
    events: [
      source('order', 'o-rate-1', '2026-09-30T10:00:00.000Z'),
      source('order', 'o-rate-2', '2026-09-30T10:01:00.000Z'),
    ],
    now: new Date('2026-10-01T10:00:00.000Z'),
  });

  assert.equal(result.matches.length >= 1, true);
});

test('notPresent is scoped to the candidate interval, not entire partition history', async () => {
  const definition = pattern({
    kind: 'notPresent',
    ref: 'cancelled',
    child: {
      kind: 'sequence',
      contiguity: 'followedBy',
      children: [
        { kind: 'event', ref: 'start' },
        { kind: 'event', ref: 'end' },
      ],
    },
  });

  const result = await evaluatePatternV2({
    definition,
    events: [
      source('cancelled', 'old-cancel', '2026-09-30T09:00:00.000Z'),
      source('start', 's-not', '2026-09-30T10:00:00.000Z'),
      source('end', 'e-not', '2026-09-30T10:01:00.000Z'),
    ],
  });

  assert.equal(result.matches.length, 1);
});

test('semantic nodes fail closed when no evaluator is configured', async () => {
  const definition = pattern({
    kind: 'semantic',
    id: 'requires-evaluator',
    refs: ['issue'],
    instruction: 'Is this urgent?',
    input: ['issue.title'],
    matchThreshold: 0.8,
    rejectThreshold: 0.2,
    child: { kind: 'event', ref: 'issue' },
  });

  await assert.rejects(
    () => evaluatePatternV2({
      definition,
      events: [
        source('issue', 'i-no-evaluator', '2026-09-30T10:00:00.000Z', {
          title: 'urgent',
        }),
      ],
    }),
    /requires a SemanticEvaluator/,
  );
});

test('targeted after-match selection refs are validated', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-pattern-v2-skip-ref-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);

    await assert.rejects(
      () => engine.register({
        triggerId: 'bad-skip-ref',
        version: '1',
        conditionOnly: true,
        clauses: [
          { id: 'a', event: 'a.event', arguments: {}, where: [] },
          { id: 'b', event: 'b.event', arguments: {}, where: [] },
        ],
        expression: { kind: 'anyOf', refs: ['a', 'b'] },
        temporal: [],
        patternV2: pattern(
          {
            kind: 'sequence',
            children: [
              { kind: 'event', ref: 'a' },
              { kind: 'event', ref: 'b' },
            ],
          },
          {
            selection: {
              overlap: 'allow',
              afterMatch: { kind: 'skipToFirst', ref: 'missing' },
              maxMatchesPerEvent: 10,
            },
          },
        ),
        withinMs: 3600000,
      }),
      /afterMatch references unknown pattern ref/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('oneShot caps multiple Pattern v2 matches produced in one ingest', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-pattern-v2-one-shot-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);

    await engine.register({
      triggerId: 'one-shot-multi-match',
      version: '1',
      clauses: [
        { id: 'a', event: 'a.event', arguments: {}, where: [] },
        { id: 'b', event: 'b.event', arguments: {}, where: [] },
      ],
      expression: { kind: 'anyOf', refs: ['a', 'b'] },
      temporal: [],
      patternV2: pattern(
        {
          kind: 'sequence',
          contiguity: 'followedByAny',
          children: [
            { kind: 'event', ref: 'a' },
            { kind: 'event', ref: 'b' },
          ],
        },
        {
          selection: {
            overlap: 'allow',
            afterMatch: 'keepAll',
            maxMatchesPerEvent: 10,
          },
        },
      ),
      withinMs: 3600000,
      lifecycle: {
        oneShot: true,
        cooldownMs: 0,
        completeOnGoal: false,
      },
      target: {
        runtime: 'test',
        kind: 'task',
        id: 'one-shot',
      },
    });

    await engine.ingest(correlatable(
      'a-one',
      'a.event',
      '2026-09-30T10:00:00.000Z',
    ));
    await engine.ingest(correlatable(
      'a-two',
      'a.event',
      '2026-09-30T10:01:00.000Z',
    ));

    const result = await engine.ingest(correlatable(
      'b-one',
      'b.event',
      '2026-09-30T10:02:00.000Z',
    ));

    assert.equal(
      result.filter((entry) => entry.matched).length,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Pattern v2 raw partition buffers fail closed at maxBufferedEvents', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-pattern-v2-buffer-limit-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);

    await engine.register({
      triggerId: 'buffer-limit',
      version: '1',
      conditionOnly: true,
      clauses: [
        { id: 'e', event: 'e.event', arguments: {}, where: [] },
      ],
      expression: { kind: 'anyOf', refs: ['e'] },
      temporal: [],
      patternV2: pattern(
        {
          kind: 'repeat',
          child: { kind: 'event', ref: 'e' },
          min: 3,
          max: 3,
          mode: 'greedy',
          contiguity: 'relaxed',
        },
        {
          execution: {
            maxCandidates: 32,
            maxSemanticEvaluations: 0,
            maxBufferedEvents: 1,
          },
        },
      ),
      withinMs: 3600000,
    });

    await engine.ingest(correlatable(
      'e-one',
      'e.event',
      '2026-09-30T10:00:00.000Z',
    ));

    await assert.rejects(
      () => engine.ingest(correlatable(
        'e-two',
        'e.event',
        '2026-09-30T10:01:00.000Z',
      )),
      (error) =>
        error.code === 'PATTERN_V2_BUFFER_LIMIT_EXCEEDED',
    );

    assert.equal(
      store.listAudit()
        .some((entry) => entry.kind === 'event.buffer_overflow'),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('semantic refs must be guaranteed by the child pattern', () => {
  assert.throws(
    () => pattern({
      kind: 'semantic',
      id: 'branch-semantic',
      refs: ['a'],
      instruction: 'Is A interesting?',
      input: ['a.value'],
      matchThreshold: 0.8,
      rejectThreshold: 0.2,
      child: {
        kind: 'anyOf',
        children: [
          { kind: 'event', ref: 'a' },
          { kind: 'event', ref: 'b' },
        ],
      },
    }),
    /semantic requires ref to be guaranteed by child pattern: a/,
  );
});

test('derived measures cannot depend on optional Pattern v2 bindings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-pattern-v2-measure-binding-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);

    await assert.rejects(
      () => engine.register({
        triggerId: 'optional-measure',
        version: '1',
        clauses: [
          { id: 'a', event: 'a.event', arguments: {}, where: [] },
          { id: 'b', event: 'b.event', arguments: {}, where: [] },
        ],
        expression: { kind: 'anyOf', refs: ['a', 'b'] },
        temporal: [],
        patternV2: pattern({
          kind: 'anyOf',
          children: [
            { kind: 'event', ref: 'a' },
            { kind: 'event', ref: 'b' },
          ],
        }),
        withinMs: 3600000,
        derivedEvent: {
          name: 'optional.measure',
          contractVersion: '1',
          constants: {},
          projections: [],
          measures: [{
            key: 'aValue',
            expression: {
              kind: 'aggregate',
              function: 'last',
              ref: 'a',
              path: 'value',
            },
          }],
        },
      }),
      /Derived measure aValue references non-guaranteed pattern ref: a/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('Pattern v2 watermark remains monotonic after match pruning', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-pattern-v2-watermark-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);

    await engine.register({
      triggerId: 'monotonic-watermark',
      version: '1',
      conditionOnly: true,
      clauses: [
        { id: 'e', event: 'e.event', arguments: {}, where: [] },
      ],
      expression: { kind: 'anyOf', refs: ['e'] },
      temporal: [],
      patternV2: pattern({
        kind: 'event',
        ref: 'e',
      }),
      eventTime: {
        allowedLatenessMs: 5 * 60 * 1000,
      },
      withinMs: 10 * 60 * 1000,
    });

    const first = await engine.ingest(correlatable(
      'newer',
      'e.event',
      '2026-09-30T10:20:00.000Z',
    ));
    assert.equal(first.some((entry) => entry.matched), true);

    const late = await engine.ingest(correlatable(
      'too-old',
      'e.event',
      '2026-09-30T10:00:00.000Z',
    ));
    assert.equal(late.some((entry) => entry.matched), false);

    const buffer = store.listTriggerMatches('monotonic-watermark')
      .filter((record) => record.patternState?.role === 'buffer')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];

    assert.equal(
      buffer.patternState.maxObservedOccurredAt,
      '2026-09-30T10:20:00.000Z',
    );
    assert.equal(
      store.listAudit()
        .some((entry) =>
          entry.kind === 'event.late_dropped' &&
          entry.details?.sourceEventId === 'too-old'
        ),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
