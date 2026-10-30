import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventIntelligence, createActivationDispatcher } from 'mcp-event-intelligence/embedded';
import { makeRuntimeHost } from './host.mjs';
import { attachEventIntelligence } from './ei-bridge.mjs';
import { attachManually } from './manual-bridge.mjs';

function populate(host) {
  host.addMember({ org: 'org-a', workspace: 'w1', team: 'red', user: 'alice' });
  host.addMember({ org: 'org-a', workspace: 'w1', team: 'red', user: 'bob' });
  host.addMember({ org: 'org-a', workspace: 'w1', team: 'blue', user: 'dana' });
  host.addMember({ org: 'org-b', workspace: 'w1', team: 'red', user: 'carol' });
  host.addAgent({ id: 'agent-a-1', org: 'org-a', workspace: 'w1', team: 'red', owner: 'alice' });
  host.addAgent({ id: 'graph-a-2', org: 'org-a', workspace: 'w1', team: 'blue', owner: 'dana', kind: 'graph' });
  host.addAgent({ id: 'agent-b-1', org: 'org-b', workspace: 'w1', team: 'red', owner: 'carol' });
  const alice = host.issueTicket({
    org: 'org-a', workspace: 'w1', team: 'red', user: 'alice', agentId: 'agent-a-1',
  });
  const bob = host.issueTicket({
    org: 'org-a', workspace: 'w1', team: 'red', user: 'bob', agentId: 'agent-a-1',
  });
  const dana = host.issueTicket({
    org: 'org-a', workspace: 'w1', team: 'blue', user: 'dana', agentId: 'graph-a-2',
  });
  const carol = host.issueTicket({
    org: 'org-b', workspace: 'w1', team: 'red', user: 'carol', agentId: 'agent-b-1',
  });
  return { alice, bob, dana, carol };
}

async function withHost(run, capabilityIds) {
  const dir = await mkdtemp(join(tmpdir(), 'ei-portable-lab-'));
  const host = makeRuntimeHost();
  const tickets = populate(host);
  try {
    const ei = await attachEventIntelligence(host, { dataDir: dir, capabilityIds });
    try {
      return await run({ host, tickets, ei });
    } finally {
      await host.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('real public npm EI host registers all eight tools and renders untrusted output', async () => {
  await withHost(async ({ host, tickets, ei }) => {
    assert.equal(ei.tools.length, 8);
    assert.equal(host.names().length, 8);
    assert.equal(new Set(host.capabilities()).size, 8);
    const sources = ei.tools.find(t => t.capability.id === 'event-intelligence.event-sources.list');
    const result = await host.invoke(sources.name, {}, tickets.alice);
    assert.equal(result.trust, 'untrusted-external');
    assert.equal(result.result.ok, true);
    assert.ok(Array.isArray(result.result.data.sources));
    const list = ei.tools.find(t => t.capability.id === 'event-intelligence.trigger.list');
    const aliceResult = await host.invoke(list.name, {}, tickets.alice);
    const carolResult = await host.invoke(list.name, {}, tickets.carol);
    assert.equal(aliceResult.result.ok, true);
    assert.equal(carolResult.result.ok, true);
    assert.deepEqual(aliceResult.result.data.triggers, []);
    assert.deepEqual(carolResult.result.data.triggers, []);
    assert.notEqual(host.resolveContext(tickets.alice).scopeId,
      host.resolveContext(tickets.carol).scopeId);
    assert.notEqual(host.resolveContext(tickets.alice).owner.principal_id,
      host.resolveContext(tickets.carol).owner.principal_id);
  });
});

test('host owns multi-agent graph targets and user/team/organization authority', async () => {
  await withHost(async ({ host, tickets, ei }) => {
    const list = ei.tools.find(t => t.capability.id === 'event-intelligence.trigger.list');
    const graph = host.resolveContext(tickets.dana);
    assert.equal(graph.target.kind, 'graph');
    assert.equal(graph.owner.principal_id, 'dana');
    assert.notEqual(graph.scopeId, host.resolveContext(tickets.carol).scopeId);
    // Another team member may read their own watches but cannot create for alice's agent.
    assert.equal(host.control({
      runtimeContext: tickets.bob, action: 'trigger.create',
    }).result.error.code, 'LAB_OWNER_REQUIRED');
    const firstApproval = host.control({
      runtimeContext: tickets.alice, action: 'trigger.create',
    });
    const secondApproval = host.control({
      runtimeContext: tickets.alice, action: 'trigger.create',
    });
    assert.equal(firstApproval.action, 'execute');
    assert.equal(typeof firstApproval.execution.confirmationId, 'string');
    assert.notEqual(firstApproval.execution.confirmationId,
      secondApproval.execution.confirmationId,
      'Every host-authorized mutation must receive a distinct confirmation');
    // A ticket is a host-minted capability, never JSON/LLM/user-provided fields.
    assert.throws(
      () => host.invoke(list.name, {}, { org: 'org-a', user: 'alice' }),
      e => e.code === 'LAB_HOST_DENIED',
    );
    host.revokeMember({ org: 'org-a', workspace: 'w1', team: 'red', user: 'alice' });
    assert.throws(() => host.invoke(list.name, {}, tickets.alice),
      e => e.code === 'LAB_HOST_DENIED');
    assert.equal((await host.invoke(list.name, {}, tickets.carol)).result.ok, true);
  });
});

test('static capability allowlist forbids unknown tools and exposes only selected operations', async () => {
  await withHost(async ({ host, tickets, ei }) => {
    assert.equal(host.names().length, 2);
    const list = ei.tools.find(t => t.capability.id === 'event-intelligence.trigger.list');
    const create = ei.tools.find(t => t.capability.id === 'event-intelligence.trigger.create');
    assert.equal((await host.invoke(list.name, {}, tickets.alice)).result.ok, true);
    assert.throws(() => host.invoke(create.name, {}, tickets.alice),
      e => e.code === 'LAB_TOOL_NOT_EXPOSED');
  }, ['event-intelligence.event-sources.list', 'event-intelligence.trigger.list']);

  const dir = await mkdtemp(join(tmpdir(), 'ei-portable-negative-'));
  const host = makeRuntimeHost();
  try {
    await assert.rejects(attachEventIntelligence(host, {
      dataDir: dir,
      capabilityIds: ['event-intelligence.trigger.list', 'foreign.unknown'],
    }), /unknown EI capability/);
    assert.equal(host.names().length, 0); // Fail before partial registration.
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('headless option uses same public EI entry without exposing agent tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ei-headless-lab-'));
  const host = makeRuntimeHost();
  try {
    const ei = await createEventIntelligence({
      dataDir: dir,
      mcp: { list: () => [] },
      runtime: { deliver: (input) => host.deliverWake(input) },
    });
    try {
      assert.equal(ei.tools.length, 0);
    } finally {
      await ei.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('host wake routing rejects revoked graph owner, duplicate receipts and collisions', async () => {
  const host = makeRuntimeHost();
  const { dana } = populate(host);
  const target = host.resolveContext(dana).target;
  const activation = { target, wake: { wakeId: 'wake-graph-1' } };
  const resolved = host.resolveWakeTarget(target);
  assert.ok(resolved);
  const first = host.deliverWake({ activation, target: resolved, receiptId: 'receipt-1' });
  assert.deepEqual(first, { runtimeReceiptId: 'receipt-1', duplicate: false });
  assert.deepEqual(host.deliverWake({
    activation, target: resolved, receiptId: 'receipt-1',
  }), { runtimeReceiptId: 'receipt-1', duplicate: true });
  assert.throws(() => host.deliverWake({
    activation: { target, wake: { wakeId: 'forged-other-wake' } },
    target: resolved, receiptId: 'receipt-1',
  }), /LAB_RECEIPT_COLLISION/);
  host.revokeMember({ org: 'org-a', workspace: 'w1', team: 'blue', user: 'dana' });
  assert.equal(host.resolveWakeTarget(target), null);
  assert.throws(() => host.deliverWake({
    activation, target: resolved, receiptId: 'receipt-1',
  }), e => e.code === 'LAB_HOST_DENIED');
});


test('actual CEP trigger creation and wake use host-owned policy, scope and opaque target', {
  timeout: 30000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ei-portable-cep-'));
  const host = makeRuntimeHost();
  const tickets = populate(host);
  try {
    const ei = await attachEventIntelligence(host, {
      dataDir: dir,
      env: {
        TEMPORAL_TICK_MS: '100000',
        WAKE_RETRY_TICK_MS: '100',
        TYPESAFE_API_KEY: '',
      },
    });
    try {
      const aliceScope = host.resolveContext(tickets.alice).scopeId;
      const owned = await ei.host.scope(aliceScope);
      await owned.triggerControl.registerEventSource({
        sourceId: 'lab:paid',
        connectionId: 'lab-events',
        serverId: 'lab-provider',
        eventName: 'lab.order.paid',
        delivery: ['poll'],
        payloadSchema: { type: 'object', properties: {
          amount: { type: 'number' },
        } },
        enabled: true,
      }, { type: 'system', principal_id: 'lab-setup-owner' });

      const create = ei.tools.find(t =>
        t.capability.id === 'event-intelligence.trigger.create');
      const list = ei.tools.find(t =>
        t.capability.id === 'event-intelligence.trigger.list');
      const args = {
        trigger_id: 'lab-order-paid',
        events: [{ event: 'lab.order.paid', serverId: 'lab-provider' }],
        instruction: 'Resume the already authorized host agent.',
        one_shot: true,
      };

      const teammate = await host.invoke(create.name, args, tickets.bob);
      assert.equal(teammate.result.ok, false);
      assert.equal(teammate.result.error.code, 'LAB_OWNER_REQUIRED');

      const owner = await host.invoke(create.name, args, tickets.alice);
      assert.equal(owner.result.ok, true, JSON.stringify(owner.result.error));
      assert.equal(owner.result.data.triggerId, 'lab-order-paid');

      const ownList = await host.invoke(list.name, {}, tickets.alice);
      const otherOrgList = await host.invoke(list.name, {}, tickets.carol);
      assert.equal(ownList.result.data.triggers.length, 1);
      assert.equal(otherOrgList.result.data.triggers.length, 0);

      // The event must enter the SAME trusted org/workspace scope as the watch.
      const ingested = await owned.runtime.compositeEventConsumer.ingestCorrelatable({
        traceId: 'lab-order-trace-1',
        sourceEventId: 'lab-paid-1',
        name: 'lab.order.paid',
        serverId: 'lab-provider',
        provider: 'lab-provider',
        occurredAt: new Date().toISOString(),
        data: { amount: 125 },
      });
      for (let i = 0; i < 80 && host.receiptCount() === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(host.receiptCount(), 1,
        'CEP event must wake the host-owned authorized agent exactly once in this process; ' +
          JSON.stringify({ deliveries: ingested.deliveries, results: ingested.results?.map(r => ({
            triggerId: r.triggerId, matched: r.matched,
          })) }));
    } finally {
      await host.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('actual EI dispatcher rejects a reused receipt with a different authorized target', async () => {
  const host = makeRuntimeHost();
  const { alice, carol } = populate(host);
  const target = host.resolveContext(alice).target;
  const activation = {
    activationVersion: '2',
    wake: {
      wakeId: 'wake-same', status: 'queued',
      runtimeReceiptId: null, matchedAt: '2026-10-30T12:00:00.000Z',
    },
    target,
    trigger: {
      triggerId: 'test-trigger', version: '1', description: null,
      pattern: {
        version: '2', root: { kind: 'event', ref: 'event_1' },
        partitionBy: [], selection: {
          overlap: 'disallow', afterMatch: 'skipPastLast', maxMatchesPerEvent: 10,
        }, execution: {
          maxCandidates: 512, maxSemanticEvaluations: 16, maxBufferedEvents: 10000,
        },
      },
      lifecycle: { oneShot: true, cooldownMs: 0, completeOnGoal: false },
    },
    continuation: {
      instruction: 'Resume authorized host job',
      contextPolicy: { evidence: 'matched_events', maxEvents: 20, includeData: true },
    },
    match: {
      matchId: 'match-1', status: 'matched', partitionKey: null,
      openedAt: '2026-10-30T12:00:00.000Z',
      updatedAt: '2026-10-30T12:00:00.000Z',
    },
    evidence: [],
    trust: {
      continuation: 'configured_trigger_instruction',
      evidence: 'untrusted_external_signal',
    },
  };
  const dispatch = createActivationDispatcher({
    receiptNamespace: host.receiptNamespace,
    requireExplicitReceipt: true,
    hasReceipt: (id, envelope) => host.hasReceipt(id, envelope),
    resolveTarget: (opaque) => host.resolveWakeTarget(opaque),
    deliver: (input) => host.deliverWake(input),
  });
  const first = await dispatch({ wake_id: 'wake-same' }, activation);
  assert.equal(first.duplicate, false);
  assert.equal(host.receiptCount(), 1);
  const replay = await dispatch({ wake_id: 'wake-same' }, activation);
  assert.equal(replay.duplicate, true);
  assert.equal(host.receiptCount(), 1);
  const otherAuthorizedTarget = host.resolveContext(carol).target;
  await assert.rejects(dispatch({ wake_id: 'wake-same' }, {
    ...activation, target: otherAuthorizedTarget,
  }), e => e.code === 'LAB_RECEIPT_COLLISION');
  assert.equal(host.receiptCount(), 1);
  host.revokeMember({
    org: 'org-a', workspace: 'w1', team: 'red', user: 'alice',
  });
  await assert.rejects(dispatch({ wake_id: 'wake-new' }, {
    ...activation, wake: { ...activation.wake, wakeId: 'wake-new' },
  }), e => e.code === 'EVENT_ACTIVATION_TARGET_UNAVAILABLE');
  assert.equal(host.receiptCount(), 1);
});


test('same native runtime: manual and existing EI binder preserve capability, policy and result semantics', {
  timeout: 30000,
}, async () => {
  const outputs = [];
  for (const attach of [attachManually, attachEventIntelligence]) {
    const dir = await mkdtemp(join(tmpdir(), 'ei-portable-ab-'));
    const host = makeRuntimeHost();
    const tickets = populate(host);
    try {
      const ei = await attach(host, {
        dataDir: dir,
        capabilityIds: ['event-intelligence.event-sources.list',
          'event-intelligence.trigger.list', 'event-intelligence.trigger.create'],
      });
      try {
        const byCapability = new Map(ei.tools.map(tool =>
          [tool.capability.id, tool.name]));
        const read = await host.invoke(
          byCapability.get('event-intelligence.trigger.list'), {}, tickets.alice);
        const teammate = await host.invoke(
          byCapability.get('event-intelligence.trigger.create'), {
            events: [{ event: 'not-registered' }], instruction: 'Follow up.',
          }, tickets.bob);
        assert.equal(read.result.ok, true);
        // In either A/B variant, an unregistered event may fail planning
        // before mutation policy. Both variants must behave equivalently.
        assert.equal(teammate.result.ok, false);
        outputs.push({
          exposed: host.names().sort(),
          capabilities: host.capabilities().sort(),
          read: read.result,
          teammate: teammate.result,
          trust: read.trust,
        });
      } finally {
        await host.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(outputs[0], outputs[1]);
});
