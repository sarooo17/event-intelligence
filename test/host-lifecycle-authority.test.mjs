import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventIntelligenceAgentTools } from '../scripts/embedded-host-kit.mjs';

const owner = { type: 'user', principal_id: 'owner', tenant_id: 'tenant-1' };
const actor = { type: 'agent', principal_id: 'agent', tenant_id: 'tenant-1' };
const target = { runtime: 'neutral-host', kind: 'task', id: 'checkpoint-1' };
const cases = [
  ['trigger_pause', 'active', { trigger_id: 'watch-1', version: '1' }, 'trigger.pause'],
  ['trigger_resume', 'paused', { trigger_id: 'watch-1', version: '1' }, 'trigger.resume'],
  ['trigger_delete', 'active', { trigger_id: 'watch-1', version: '1' }, 'trigger.delete'],
  ['trigger_update', 'active', {
    trigger_id: 'watch-1',
    expected_version: '1',
    version: '2',
    description: 'Host-managed update',
    events: [{
      id: 'source',
      event: 'demo.changed',
      serverId: 'demo',
      arguments: { project: 'sample-repository' },
      where: [{ path: 'value', op: 'gt', value: 5 }],
    }],
    pattern: { root: { kind: 'event', ref: 'source' } },
    within_ms: 120000,
    event_time: { allowed_lateness_ms: 500 },
    instruction: 'Continue after a new event',
    one_shot: false,
    max_firings: 4,
    cooldown_ms: 100,
    expires_at: '2026-12-01T00:00:00+00:00',
    lease_until: '2026-11-30T00:00:00+00:00',
    complete_on_goal: true,
  }, 'trigger.update'],
];

function hostFixture(status) {
  const writes = [];
  const entry = {
    definition: {
      triggerId: 'watch-1', version: '1',
      clauses: [{ id: 'source', serverId: 'demo', event: 'demo.changed' }],
      lifecycle: { oneShot: false, maxFirings: 5 },
      target,
      continuation: { instruction: 'Continue after the original event' },
    },
    state: {
      status, fireCount: 0, owner,
      connectionIds: ['demo-connection'],
    },
  };
  const host = {
    eventSources: [],
    async refreshMcpRegistry() {},
    async planTrigger(input) {
      return {
        definition: { ...entry.definition, version: input.version },
        connectionIds: ['demo-connection'],
        warnings: [],
      };
    },
    triggerControl: {
      async listTriggers() { return [entry]; },
      async pauseTrigger() { writes.push('pause'); },
      async resumeTrigger() { writes.push('resume'); },
      async updateTrigger() { writes.push('update'); },
      async deleteTrigger() { writes.push('delete'); },
    },
  };
  return { host, writes, entry };
}

function makeTools(host, control) {
  return new Map(createEventIntelligenceAgentTools({
    host,
    resolveContext() { return { target, actor, owner }; },
    control,
  }).map(tool => [tool.name, tool]));
}

test('host-owned denial prevents all four lifecycle mutations and preserves native denial', async () => {
  for (const [name, status, args, expectedAction] of cases) {
    const { host, writes, entry } = hostFixture(status);
    const calls = [];
    const denial = {
      ok: false,
      error: { code: 'HOST_APPROVAL_REQUIRED', message: 'Host approval pending' },
    };
    const tools = makeTools(host, input => {
      calls.push(input);
      return { action: 'return', result: denial };
    });
    const before = structuredClone(entry);
    const result = await tools.get(name).execute(args, { sessionId: 'host-turn' });
    assert.deepEqual(result, denial, name + ' must preserve host denial');
    assert.deepEqual(writes, [], name + ' bypassed host control');
    assert.deepEqual(entry, before, name + ' modified state without approval');
    assert.equal(calls.length, 1, name + ' did not invoke host control exactly once');
    assert.equal(calls[0].action, expectedAction);
    assert.deepEqual(calls[0].input, args,
      name + ' altered the original validated lifecycle control input');
    assert.equal(typeof calls[0].capability?.id, 'string');
    assert.equal(calls[0].context.owner.tenant_id, 'tenant-1');
  }
});

test('native host interrupts propagate unchanged across lifecycle operations', async () => {
  for (const [name, status, args, expectedAction] of cases) {
    const { host, writes, entry } = hostFixture(status);
    const interrupt = Object.assign(new Error('suspend host execution'), {
      name: 'HostInterrupt',
      hostContinuationId: 'opaque-host-checkpoint',
    });
    const calls = [];
    const tools = makeTools(host, input => {
      calls.push(input);
      throw interrupt;
    });
    const before = structuredClone(entry);
    const interruptDescriptors = Object.getOwnPropertyDescriptors(interrupt);
    const interruptKeys = Reflect.ownKeys(interrupt);
    await assert.rejects(
      tools.get(name).execute(args, { sessionId: 'host-turn' }),
      error => error === interrupt,
      name + ' must propagate the exact host interrupt object',
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, expectedAction);
    assert.deepEqual(calls[0].input, args,
      name + ' altered the lifecycle input on the native interrupt path');
    assert.deepEqual(Object.getOwnPropertyDescriptors(interrupt), interruptDescriptors,
      name + ' mutated native interrupt properties/descriptors');
    assert.deepEqual(Reflect.ownKeys(interrupt), interruptKeys);
    assert.deepEqual(writes, [], name + ' mutated after native host interrupt');
    assert.deepEqual(entry, before);
  }
});
