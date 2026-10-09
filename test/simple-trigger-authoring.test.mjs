import assert from 'node:assert/strict';
import test from 'node:test';
import { toTriggerPlan } from '../scripts/embedded-host-kit.mjs';
import { TriggerPlanner } from '../scripts/lib/trigger-planner.mjs';

const target = { runtime: 'clean-room', kind: 'workflow', id: 'wf-1' };

test('simple one-event form compiles into the canonical planner input with defaults', () => {
  const plan = toTriggerPlan({
    when: {
      event: 'github.issue.updated',
      serverId: 'github',
      where: [{ path: 'priority', op: 'gte', value: 2 }],
    },
    then: {
      target,
      instruction: 'Review the issue change for importance.',
    },
    lifecycle: { oneShot: true },
  });

  assert.equal(plan.version, '1');
  assert.equal(plan.withinMs, 3600000);
  assert.deepEqual(plan.events, [{
    event: 'github.issue.updated',
    serverId: 'github',
    arguments: {},
    where: [{ path: 'priority', op: 'gte', value: 2 }],
  }]);
  assert.deepEqual(plan.target, target);
  assert.equal(plan.continuation.instruction, 'Review the issue change for importance.');
  assert.equal(plan.lifecycle.oneShot, true);
  assert.equal(plan.conditionOnly, false);
  assert.equal(plan.pattern, undefined);
});

test('canonical TriggerPlanner resolves and validates simple plans against live source schemas', async () => {
  const store = {
    async listEventSources() {
      return [{
        sourceId: 'github:issue-updated',
        connectionId: 'conn-github',
        serverId: 'github',
        eventName: 'github.issue.updated',
        delivery: ['poll'],
        enabled: true,
        inputSchema: { type: 'object', additionalProperties: false },
        payloadSchema: {
          type: 'object',
          properties: { priority: { type: 'number' } },
        },
      }];
    },
  };
  const planner = new TriggerPlanner({ store });
  const declared = toTriggerPlan({
    when: {
      event: 'github.issue.updated',
      where: [{ path: 'priority', op: 'gte', value: 2 }],
    },
    then: { target, instruction: 'Summarize important changes.' },
    lifecycle: { oneShot: false, maxFirings: 3 },
  });
  const planned = await planner.plan(declared);
  assert.equal(planned.planVersion, '2');
  assert.deepEqual(planned.connectionIds, ['conn-github']);
  assert.deepEqual(planned.definition.pattern.root, {
    kind: 'event',
    ref: 'event_1',
  });
  assert.deepEqual(planned.definition.target, target);
  assert.equal(planned.definition.lifecycle.maxFirings, 3);
  assert.deepEqual(planned.definition.clauses[0].where, declared.events[0].where);

  // Same canonical source-schema validation, not a second simple-DSL evaluator.
  await assert.rejects(
    () => planner.plan(toTriggerPlan({
      when: {
        event: 'github.issue.updated',
        where: [{ path: 'missing_field', op: 'eq', value: 'secret' }],
      },
      then: { target, instruction: 'Never bypass source schema.' },
    })),
    (error) => error.code === 'TRIGGER_PLAN_FIELD_UNAVAILABLE',
  );
});

test('simple authoring rejects unknown or malformed fields rather than silently ignoring conditions', () => {
  assert.throws(
    () => toTriggerPlan({
      when: { event: 'github.issue.updated', filter: { priority: 2 } },
      then: { target, instruction: 'Review' },
    }),
    /Unknown simple trigger when property: filter/,
  );
  assert.throws(
    () => toTriggerPlan({
      when: { event: 'github.issue.updated' },
      then: { target, instruction: 'Review', elevated: true },
    }),
    /Unknown simple trigger then property: elevated/,
  );
  assert.throws(
    () => toTriggerPlan({
      when: { event: 'github.issue.updated' },
      then: { target, instruction: 'Review' },
      conditionOnly: true,
    }),
    /Unknown simple trigger option: conditionOnly/,
  );
  assert.throws(
    () => toTriggerPlan({ when: { event: 'github.issue.updated' } }),
    /then.target and then.instruction/,
  );
});
