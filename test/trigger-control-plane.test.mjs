import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TriggerControlPlane } from '../scripts/lib/trigger-control-plane.mjs';

function definition() {
  return {
    protocolVersion: '0.1.0',
    schemaVersion: 'trigger.v0.1',
    triggerId: 'gmail-and-github-agent-authored',
    version: '1',
    clauses: [
      {
        id: 'issue',
        event: 'github.issue.opened',
        serverId: 'github-events:conn_github_1',
        where: [],
      },
      {
        id: 'mail',
        event: 'email.received',
        serverId: 'gmail-events:conn_gmail_1',
        where: [
          { path: 'from', op: 'eq', value: 'pippo@example.com' },
        ],
      },
    ],
    expression: { kind: 'allOf', refs: ['issue', 'mail'] },
    withinMs: 86_400_000,
    target: {
      runtime: 'runtime-probe',
      kind: 'task',
      id: 'issue-report',
    },
  };
}

const actor = {
  type: 'agent',
  principal_id: 'event-agent:orchestrator',
  tenant_id: 'tenant_1',
};

const owner = {
  type: 'user',
  principal_id: 'user_1',
  tenant_id: 'tenant_1',
};

async function seedSources(control) {
  await control.registerEventSource({
    sourceId: 'source_github_issue',
    connectionId: 'conn_github_1',
    serverId: 'github-events:conn_github_1',
    eventName: 'github.issue.opened',
    delivery: ['webhook'],
    enabled: true,
  }, { type: 'user', principal_id: 'user_1', tenant_id: 'tenant_1' });

  await control.registerEventSource({
    sourceId: 'source_gmail_received',
    connectionId: 'conn_gmail_1',
    serverId: 'gmail-events:conn_gmail_1',
    eventName: 'email.received',
    delivery: ['webhook'],
    enabled: true,
  }, { type: 'user', principal_id: 'user_1', tenant_id: 'tenant_1' });
}

test('agent trigger create requires confirmation and connected event sources', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc012-control-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    const control = new TriggerControlPlane({ store, triggerEngine: engine });
    await seedSources(control);

    await assert.rejects(
      () => control.createTrigger({
        definition: definition(),
        connectionIds: ['conn_github_1', 'conn_gmail_1'],
        actor,
        owner,
      }),
      (error) => error.code === 'TRIGGER_CONFIRMATION_REQUIRED',
    );

    const created = await control.createTrigger({
      definition: definition(),
      connectionIds: ['conn_github_1', 'conn_gmail_1'],
      actor,
      owner,
      confirmationId: 'confirm_123',
    });

    assert.equal(created.state.status, 'active');
    assert.equal(created.definition.clauses[1].serverId, 'gmail-events:conn_gmail_1');
    assert.match(created.receiptId, /^trigger_receipt_/);
    assert.equal(await store.verifyAudit(), true);
    assert.ok(store.listAudit().some((record) => record.kind === 'trigger.created'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('agent cannot invent an event source outside active connections', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc012-source-deny-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    const control = new TriggerControlPlane({ store, triggerEngine: engine });
    await seedSources(control);

    const bad = definition();
    bad.clauses[1] = {
      ...bad.clauses[1],
      event: 'gmail.secret.nonexistent',
    };

    await assert.rejects(
      () => control.createTrigger({
        definition: bad,
        connectionIds: ['conn_github_1', 'conn_gmail_1'],
        actor,
        owner,
        confirmationId: 'confirm_bad',
      }),
      (error) => error.code === 'TRIGGER_EVENT_SOURCE_UNAVAILABLE',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a second owner cannot replace an existing trigger version', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc012-owner-collision-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const control = new TriggerControlPlane({
      store,
      triggerEngine: new CompositeTriggerEngine(store),
    });
    await seedSources(control);
    await control.createTrigger({
      definition: definition(),
      connectionIds: ['conn_github_1', 'conn_gmail_1'],
      actor,
      owner,
      confirmationId: 'confirm_first',
    });

    await assert.rejects(
      () => control.createTrigger({
        definition: definition(),
        connectionIds: ['conn_github_1', 'conn_gmail_1'],
        actor,
        owner: { ...owner, principal_id: 'user_2' },
        confirmationId: 'confirm_second',
      }),
      (error) => error.code === 'TRIGGER_ALREADY_EXISTS',
    );
    assert.equal(
      store.getTriggerState(definition().triggerId, '1').owner.principal_id,
      'user_1',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pause and resume survive restart and gate matching', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc012-pause-'));
  try {
    const firstStore = new PersistentEventStore(dir);
    await firstStore.init();
    const firstEngine = new CompositeTriggerEngine(firstStore);
    const firstControl = new TriggerControlPlane({
      store: firstStore,
      triggerEngine: firstEngine,
    });
    await seedSources(firstControl);

    await firstControl.createTrigger({
      definition: definition(),
      connectionIds: ['conn_github_1', 'conn_gmail_1'],
      actor,
      owner,
      confirmationId: 'confirm_create',
    });
    await firstControl.pauseTrigger({
      triggerId: 'gmail-and-github-agent-authored',
      version: '1',
      actor,
      owner,
      confirmationId: 'confirm_pause',
    });

    const secondStore = new PersistentEventStore(dir);
    const restored = await secondStore.init();
    assert.equal(restored.triggerStates, 1);
    assert.equal(restored.eventSources, 2);

    const secondEngine = new CompositeTriggerEngine(secondStore);
    const secondControl = new TriggerControlPlane({
      store: secondStore,
      triggerEngine: secondEngine,
    });

    const ignored = await secondEngine.ingest({
      traceId: 'trace_paused',
      sourceEventId: 'gh_paused',
      name: 'github.issue.opened',
      serverId: 'github-events:conn_github_1',
      occurredAt: '2026-09-18T12:00:00.000Z',
      data: {},
    });
    assert.deepEqual(ignored, []);

    await secondControl.resumeTrigger({
      triggerId: 'gmail-and-github-agent-authored',
      version: '1',
      actor,
      owner,
      confirmationId: 'confirm_resume',
    });

    const active = await secondEngine.ingest({
      traceId: 'trace_active',
      sourceEventId: 'gh_active',
      name: 'github.issue.opened',
      serverId: 'github-events:conn_github_1',
      occurredAt: '2026-09-18T12:01:00.000Z',
      data: {},
    });
    assert.equal(active.length, 1);
    assert.equal(active[0].match.status, 'partial');
    assert.ok(secondStore.listAudit().some((record) => record.kind === 'trigger.paused'));
    assert.ok(secondStore.listAudit().some((record) => record.kind === 'trigger.resumed'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('control plane rejects agent-authored predicate fields not advertised by the source schema', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-control-schema-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    const control = new TriggerControlPlane({ store, triggerEngine: engine });

    await control.registerEventSource({
      sourceId: 'schema-source',
      connectionId: 'schema-conn',
      serverId: 'schema-server',
      eventName: 'issue.opened',
      delivery: ['poll'],
      enabled: true,
      payloadSchema: {
        type: 'object',
        properties: {
          repository: { type: 'string' },
        },
      },
    }, { type: 'system', principal_id: 'test' });

    await assert.rejects(
      () => control.createTrigger({
        definition: {
          triggerId: 'invalid-agent-field',
          version: '1',
          clauses: [{
            id: 'issue',
            event: 'issue.opened',
            serverId: 'schema-server',
            where: [{ path: 'secretField', op: 'exists', value: true }],
          }],
          expression: { kind: 'anyOf', refs: ['issue'] },
          withinMs: 60000,
          target: { runtime: 'agent', kind: 'task', id: 'agent-1' },
        },
        connectionIds: ['schema-conn'],
        actor: { type: 'agent', principal_id: 'agent-1' },
        owner: { type: 'user', principal_id: 'user-1' },
        confirmationId: 'confirmed',
      }),
      (error) => error.code === 'TRIGGER_SOURCE_FIELD_UNAVAILABLE',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
