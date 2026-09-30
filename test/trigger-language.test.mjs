import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PatternNodeV2Schema,
  StructuredPredicateSchema,
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

  for (const entry of TRIGGER_LANGUAGE_CATALOG.pattern) {
    if (!entry.example) continue;
    assert.doesNotThrow(
      () => PatternNodeV2Schema.parse(entry.example),
      `invalid Pattern registry example: ${entry.id}`,
    );
  }
});

test('trigger language exposes one Pattern category', () => {
  const pattern = describeTriggerLanguage({ category: 'pattern' });
  assert.equal(pattern.version, '3');
  assert.ok(pattern.pattern.length >= 20);
  assert.equal(
    pattern.pattern.some((entry) => entry.id === 'absence'),
    true,
  );

  const absence = describeTriggerLanguage({
    category: 'pattern',
    operator: 'absence',
  });
  assert.equal(absence.pattern.length, 1);
  assert.equal(absence.pattern[0].id, 'absence');

  const missing = describeTriggerLanguage({
    category: 'pattern',
    operator: 'does-not-exist',
  });
  assert.deepEqual(missing.pattern, []);
  assert.equal(pattern.preferredAuthoring, 'TriggerPlanInput.pattern');
  assert.equal(
    pattern.canonicalRepresentation,
    'CompositeTriggerDefinition.pattern',
  );
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

test('agent-friendly planner persists temporal semantics inside Pattern AST', async () => {
  const sources = [
    eventSource('mail', 'email.received', { threadId: { type: 'string' } }),
    eventSource('reply', 'email.replied', { threadId: { type: 'string' } }),
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
      { id: 'mail', event: 'email.received' },
      { id: 'reply', event: 'email.replied' },
    ],
    pattern: {
      root: {
        kind: 'absence',
        id: 'no-reply',
        child: { kind: 'event', ref: 'mail' },
        ref: 'reply',
        afterRef: 'mail',
        forMs: 600000,
      },
      partitionBy: [{
        key: 'thread',
        fields: [
          { ref: 'mail', path: 'threadId' },
          { ref: 'reply', path: 'threadId' },
        ],
      }],
    },
  });

  assert.equal(planned.planVersion, '2');
  assert.equal(planned.definition.pattern.root.kind, 'absence');
  assert.equal(planned.definition.conditionOnly, true);
  assert.equal('temporal' in planned.definition, false);
  assert.equal('expression' in planned.definition, false);
  assert.equal('correlation' in planned.definition, false);
});

test('planner rejects unknown Pattern refs and unavailable partition fields', async () => {
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
      pattern: {
        root: {
          kind: 'allOf',
          children: [
            { kind: 'event', ref: 'order' },
            { kind: 'event', ref: 'missing' },
          ],
        },
      },
    }),
    (error) => error.code === 'TRIGGER_PLAN_EVENT_REF_UNKNOWN',
  );

  await assert.rejects(
    () => planner.plan({
      conditionOnly: true,
      events: [{ id: 'order', event: 'order.created' }],
      pattern: {
        root: { kind: 'event', ref: 'order' },
        partitionBy: [{
          key: 'secret',
          fields: [{ ref: 'order', path: 'secretField' }],
        }],
      },
    }),
    (error) => error.code === 'TRIGGER_PLAN_FIELD_UNAVAILABLE',
  );
});
