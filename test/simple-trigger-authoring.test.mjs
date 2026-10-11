import assert from 'node:assert/strict';
import test from 'node:test';
import { toTriggerPlan } from '../scripts/embedded-host-kit.mjs';
import { TriggerPlanner } from '../scripts/lib/trigger-planner.mjs';
import { canonicalJson, parseTriggerPlanInput } from '../dist/src/intelligenceProtocol/index.js';

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

test('simple authoring rejects silent predicate modifier stripping but keeps valid regex flags', () => {
  const then = {
    target,
    instruction: 'Review event safely.',
    contextPolicy: { evidence: 'refs_only' },
  };
  assert.throws(
    () => toTriggerPlan({
      when: {
        event: 'github.issue.updated',
        where: [{ path: 'priority', op: 'gte', value: 2, negate: true }],
      },
      then,
    }),
    /Unknown when\.where\[0\] predicate property: negate/,
  );
  const plan = toTriggerPlan({
    when: {
      event: 'github.issue.updated',
      where: [{ path: 'title', op: 'regex', value: 'bug', flags: 'i' }],
    },
    then,
  });
  assert.equal(plan.events[0].where[0].flags, 'i');
  assert.equal(plan.continuation.contextPolicy.evidence, 'refs_only');
  assert.equal(plan.continuation.contextPolicy.maxEvents, 50);
});

test('simple authoring is byte-identical to canonical wire planning for 256 independent option combinations', async () => {
  const planner = new TriggerPlanner({
    store: {
      async listEventSources() {
        return [{
          sourceId: 'github:issue-updated',
          connectionId: 'conn-github', serverId: 'github',
          eventName: 'github.issue.updated', enabled: true,
          inputSchema: {
            type: 'object',
            properties: { repo: { type: 'string' } },
            additionalProperties: false,
          },
          payloadSchema: {
            type: 'object',
            properties: {
              priority: { type: 'number' },
              title: { type: 'string' },
            },
          },
        }];
      },
    },
  });
  // Independent bit gates cover both sides of every formerly paired field
  // (id/version, serverId/description, arguments/withinMs, where/lifecycle).
  // Additional coprime gates exercise eventTime, contextPolicy and triggerId.
  for (let seed = 0; seed < 256; seed += 1) {
    const when = {
      event: 'github.issue.updated',
      ...(seed & 1 ? { id: 'issue' } : {}),
      ...(seed & 2 ? { serverId: 'github' } : {}),
      ...(seed & 4 ? { arguments: { repo: 'example/project' } } : {}),
      ...(seed & 8 ? { where: [{ path: 'priority', op: 'gte', value: 2 }] } : {}),
    };
    const then = {
      target,
      instruction: 'Review the issue change for importance.',
      ...(seed % 5 === 0 ? { contextPolicy: { evidence: 'refs_only' } } : {}),
    };
    const options = {
      ...(seed % 7 === 0 ? { triggerId: 'same-id-' + seed } : {}),
      ...(seed & 16 ? { version: '3' } : {}),
      ...(seed & 32 ? { description: 'Issue watch' } : {}),
      ...(seed & 64 ? { withinMs: 120000 } : {}),
      ...(seed & 128 ? { lifecycle: seed % 2
        ? { oneShot: true, maxFirings: 1 }
        : { oneShot: false, maxFirings: 2 } } : {}),
      ...(seed % 3 === 0 ? { eventTime: { allowedLatenessMs: 250 } } : {}),
    };
    const simple = toTriggerPlan({ when, then, ...options });
    const manual = parseTriggerPlanInput({
      events: [{
        ...(when.id ? { id: when.id } : {}),
        event: when.event,
        ...(when.serverId ? { serverId: when.serverId } : {}),
        ...(when.arguments ? { arguments: when.arguments } : {}),
        ...(when.where ? { where: when.where } : {}),
      }],
      target: then.target,
      continuation: {
        instruction: then.instruction,
        ...(then.contextPolicy ? { contextPolicy: then.contextPolicy } : {}),
      },
      ...options,
    });
    assert.deepEqual(
      Buffer.from(canonicalJson(simple), 'utf8'),
      Buffer.from(canonicalJson(manual), 'utf8'),
      'canonical plan byte parity seed=' + seed,
    );
    const simpleResolved = await planner.plan(simple);
    const manuallyResolved = await planner.plan(manual);
    assert.deepEqual(
      Buffer.from(canonicalJson(simpleResolved), 'utf8'),
      Buffer.from(canonicalJson(manuallyResolved), 'utf8'),
      'planned definition, source resolution, ID and receipt byte parity seed=' + seed,
    );
  }
});
