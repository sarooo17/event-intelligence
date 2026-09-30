import assert from 'node:assert/strict';
import test from 'node:test';

import {
  StructuredPredicateSchema,
  TemporalConditionSchema,
  TriggerPlanMatchSchema,
  TRIGGER_LANGUAGE_CATALOG,
  describeTriggerLanguage,
} from '../dist/src/intelligenceProtocol/index.js';
import { TriggerPlanner } from '../scripts/lib/trigger-planner.mjs';

test('trigger language registry examples stay valid against canonical schemas', () => {
  for (const entry of TRIGGER_LANGUAGE_CATALOG.predicates) {
    assert.doesNotThrow(
      () => StructuredPredicateSchema.parse(entry.example),
      `invalid predicate registry example: ${entry.id}`,
    );
  }

  for (const entry of TRIGGER_LANGUAGE_CATALOG.temporal) {
    assert.doesNotThrow(
      () => TemporalConditionSchema.parse(entry.example),
      `invalid temporal registry example: ${entry.id}`,
    );
  }

  for (const entry of TRIGGER_LANGUAGE_CATALOG.composition) {
    assert.doesNotThrow(
      () => TriggerPlanMatchSchema.parse(entry.example.match),
      `invalid composition registry example: ${entry.id}`,
    );
  }
});

test('trigger language can be discovered by category or operator', () => {
  const temporal = describeTriggerLanguage({ category: 'temporal' });
  assert.equal(temporal.version, '2');
  assert.equal(temporal.temporal.length, 10);
  assert.equal(
    temporal.temporal.some((entry) => entry.id === 'absence'),
    true,
  );

  const absence = describeTriggerLanguage({
    category: 'temporal',
    operator: 'absence',
  });
  assert.equal(absence.temporal.length, 1);
  assert.equal(absence.temporal[0].id, 'absence');

  const missing = describeTriggerLanguage({
    category: 'temporal',
    operator: 'does-not-exist',
  });
  assert.deepEqual(missing.temporal, []);
});

function eventSource(id, eventName, properties = {}) {
  return {
    sourceId: `source-${id}`,
    connectionId: `connection-${id}`,
    serverId: `server-${id}`,
    eventName,
    enabled: true,
    delivery: ['poll'],
    inputSchema: {},
    payloadSchema: {
      type: 'object',
      properties,
    },
  };
}

test('agent-friendly planner compiles the full temporal operator set', async () => {
  const sources = [
    eventSource('order', 'order.created', {
      customer: { type: 'string' },
      grand_total: { type: 'number' },
    }),
    eventSource('deploy', 'deploy.succeeded'),
    eventSource('error', 'production.error'),
    eventSource('merge', 'pr.merged'),
    eventSource('approval', 'manager.approved'),
    eventSource('expiry', 'release.expired'),
    eventSource('change', 'config.changed'),
    eventSource('comment', 'issue.commented'),
    eventSource('blocked', 'release.blocked'),
    eventSource('cancelled', 'order.cancelled'),
  ];

  const planner = new TriggerPlanner({
    store: {
      listEventSources() {
        return sources;
      },
    },
  });

  const planned = await planner.plan({
    conditionOnly: true,
    events: [
      { id: 'order', event: 'order.created' },
      { id: 'deploy', event: 'deploy.succeeded' },
      { id: 'error', event: 'production.error' },
      { id: 'merge', event: 'pr.merged' },
      { id: 'approval', event: 'manager.approved' },
      { id: 'expiry', event: 'release.expired' },
      { id: 'change', event: 'config.changed' },
      { id: 'comment', event: 'issue.commented' },
      { id: 'blocked', event: 'release.blocked' },
      { id: 'cancelled', event: 'order.cancelled' },
    ],
    match: 'any',
    temporal: [
      {
        id: 'business-hours',
        kind: 'calendar',
        ref: 'order',
        timezone: 'Europe/Rome',
        after: '09:00',
        before: '18:00',
        weekdays: [1, 2, 3, 4, 5],
      },
      {
        id: 'no-errors',
        kind: 'absence',
        ref: 'error',
        afterRef: 'deploy',
        forMs: 600000,
      },
      { id: 'not-cancelled', kind: 'not', ref: 'cancelled' },
      { id: 'unless-blocked', kind: 'unless', ref: 'blocked' },
      {
        id: 'deploy-after-merge',
        kind: 'after',
        ref: 'deploy',
        afterRef: 'merge',
      },
      {
        id: 'approval-before-expiry',
        kind: 'until',
        ref: 'approval',
        beforeRef: 'expiry',
      },
      {
        id: 'quiet-config',
        kind: 'debounce',
        ref: 'change',
        forMs: 300000,
      },
      {
        id: 'three-comments',
        kind: 'threshold',
        ref: 'comment',
        atLeast: 3,
      },
      {
        id: 'order-spike',
        kind: 'rate',
        ref: 'order',
        atLeast: 5,
        perMs: 600000,
      },
      {
        id: 'three-customers',
        kind: 'distinct',
        ref: 'order',
        path: 'customer',
        atLeast: 3,
      },
    ],
  });

  assert.equal(planned.definition.temporal.length, 10);
  assert.deepEqual(
    planned.definition.temporal.map((condition) => condition.kind),
    [
      'calendar',
      'absence',
      'not',
      'unless',
      'after',
      'until',
      'debounce',
      'threshold',
      'rate',
      'distinct',
    ],
  );
  assert.deepEqual(
    planned.explanation.when.temporal,
    planned.definition.temporal,
  );
  assert.equal(planned.definition.conditionOnly, true);
});

test('planner validates temporal refs and distinct payload paths', async () => {
  const planner = new TriggerPlanner({
    store: {
      listEventSources() {
        return [
          eventSource('order', 'order.created', {
            customer: { type: 'string' },
          }),
        ];
      },
    },
  });

  await assert.rejects(
    () => planner.plan({
      conditionOnly: true,
      events: [{ id: 'order', event: 'order.created' }],
      temporal: [{
        id: 'bad-ref',
        kind: 'after',
        ref: 'order',
        afterRef: 'missing',
      }],
    }),
    (error) => error.code === 'TRIGGER_PLAN_EVENT_REF_UNKNOWN',
  );

  await assert.rejects(
    () => planner.plan({
      conditionOnly: true,
      events: [{ id: 'order', event: 'order.created' }],
      temporal: [{
        id: 'bad-path',
        kind: 'distinct',
        ref: 'order',
        path: 'secretField',
        atLeast: 2,
      }],
    }),
    (error) => error.code === 'TRIGGER_PLAN_FIELD_UNAVAILABLE',
  );
});
