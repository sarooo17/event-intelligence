import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import { CompositeWakeCoordinator } from '../scripts/lib/composite-wake-coordinator.mjs';
import {
  DerivedEventCoordinator,
  DERIVED_EVENT_CONNECTION_ID,
  DERIVED_EVENT_SERVER_ID,
} from '../scripts/lib/derived-event-coordinator.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TriggerControlPlane } from '../scripts/lib/trigger-control-plane.mjs';

const user = { type: 'user', principal_id: 'user_1' };

function source(sourceId, connectionId, eventName, properties = {}) {
  return {
    sourceId,
    connectionId,
    serverId: connectionId,
    eventName,
    enabled: true,
    delivery: ['internal'],
    payloadSchema: {
      type: 'object',
      properties,
    },
  };
}

function event({
  id,
  name,
  serverId,
  at,
  data = {},
}) {
  return {
    traceId: `trace_${id}`,
    sourceEventId: id,
    name,
    serverId,
    provider: 'test',
    occurredAt: at,
    data,
  };
}

test('derived events compose triggers end-to-end without intermediate runtime wakes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc020-compose-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    const control = new TriggerControlPlane({
      store,
      triggerEngine: engine,
    });

    await control.registerEventSource(
      source('src_pr', 'github', 'pr.merged', {
        repository: { type: 'string' },
        number: { type: 'integer' },
      }),
      user,
    );
    await control.registerEventSource(
      source('src_deploy', 'railway', 'deploy.succeeded', {
        repository: { type: 'string' },
        environment: { type: 'string' },
      }),
      user,
    );
    await control.registerEventSource(
      source('src_approval', 'approval', 'manager.approved', {
        release: { type: 'string' },
      }),
      user,
    );

    await control.createTrigger({
      definition: {
        triggerId: 'release-readiness',
        version: '1',
        clauses: [
          {
            id: 'pr',
            event: 'pr.merged',
            serverId: 'github',
            where: [],
          },
          {
            id: 'deploy',
            event: 'deploy.succeeded',
            serverId: 'railway',
            where: [],
          },
        ],
        expression: { kind: 'allOf', refs: ['pr', 'deploy'] },
        withinMs: 60 * 60 * 1000,
        derivedEvent: {
          name: 'release.ready',
          contractVersion: '1',
          projections: [
            { key: 'repository', ref: 'pr', path: 'repository' },
          ],
          constants: { readiness: 'stable' },
        },
      },
      connectionIds: ['github', 'railway'],
      actor: user,
      owner: user,
    });

    const releaseSource = control.listEventSources({
      connectionIds: [DERIVED_EVENT_CONNECTION_ID],
    }).find((candidate) => candidate.eventName === 'release.ready');
    assert.ok(releaseSource);
    assert.equal(releaseSource.serverId, DERIVED_EVENT_SERVER_ID);
    assert.equal(
      releaseSource.payloadSchema.properties.repository.type,
      'string',
    );

    await control.createTrigger({
      definition: {
        triggerId: 'rollout-gate',
        version: '1',
        clauses: [
          {
            id: 'release',
            event: 'release.ready',
            serverId: DERIVED_EVENT_SERVER_ID,
            where: [
              { path: 'readiness', op: 'eq', value: 'stable' },
            ],
          },
          {
            id: 'approval',
            event: 'manager.approved',
            serverId: 'approval',
            where: [],
          },
        ],
        expression: { kind: 'allOf', refs: ['release', 'approval'] },
        withinMs: 60 * 60 * 1000,
        derivedEvent: {
          name: 'rollout.allowed',
          contractVersion: '1',
          projections: [
            { key: 'repository', ref: 'release', path: 'repository' },
          ],
          constants: { gate: 'approved' },
        },
      },
      connectionIds: [DERIVED_EVENT_CONNECTION_ID, 'approval'],
      actor: user,
      owner: user,
    });

    await control.createTrigger({
      definition: {
        triggerId: 'runtime-final',
        version: '1',
        clauses: [
          {
            id: 'rollout',
            event: 'rollout.allowed',
            serverId: DERIVED_EVENT_SERVER_ID,
            where: [],
          },
        ],
        expression: { kind: 'anyOf', refs: ['rollout'] },
        withinMs: 60 * 60 * 1000,
        lifecycle: { oneShot: true },
        target: {
          runtime: 'runtime-probe',
          kind: 'task',
          id: 'deploy-production',
        },
      },
      connectionIds: [DERIVED_EVENT_CONNECTION_ID],
      actor: user,
      owner: user,
    });

    const wakeCoordinator = new CompositeWakeCoordinator({
      store,
      triggerEngine: engine,
      packetBuilder: ({ wakeId, match, definition }) => ({
        version: '1',
        wakeId,
        matchId: match.matchId,
        target: definition.target,
      }),
      deliverer: async (packet) => ({
        runtimeReceiptId: `receipt:${packet.wakeId}`,
      }),
    });
    const derivedCoordinator = new DerivedEventCoordinator({ store });
    const consumer = new CompositeEventConsumer({
      store,
      triggerEngine: engine,
      derivedEventCoordinator: derivedCoordinator,
      wakeCoordinators: new Map([
        ['runtime-probe', wakeCoordinator],
      ]),
    });

    const prResult = await consumer.ingestCorrelatable(event({
      id: 'pr_218',
      name: 'pr.merged',
      serverId: 'github',
      at: '2026-09-18T20:00:00.000Z',
      data: {
        repository: 'acme/app',
        number: 218,
        secretBody: 'must-not-enter-lineage',
      },
    }));
    assert.equal(prResult.derivedEvents.length, 0);

    const deployResult = await consumer.ingestCorrelatable(event({
      id: 'deploy_218',
      name: 'deploy.succeeded',
      serverId: 'railway',
      at: '2026-09-18T20:05:00.000Z',
      data: {
        repository: 'acme/app',
        environment: 'production',
      },
    }));

    assert.equal(store.listDerivedEvents({ name: 'release.ready' }).length, 1);
    const release = store.listDerivedEvents({ name: 'release.ready' })[0];
    assert.equal(release.event.data.repository, 'acme/app');
    assert.equal(release.event.data.readiness, 'stable');
    assert.equal(release.rootEvidence.length, 2);
    assert.equal(JSON.stringify(release.rootEvidence).includes('secretBody'), false);
    assert.equal(
      store.listTriggerMatches('rollout-gate')[0].status,
      'partial',
    );
    assert.equal(deployResult.deliveries.length, 0);

    const approvalResult = await consumer.ingestCorrelatable(event({
      id: 'approval_218',
      name: 'manager.approved',
      serverId: 'approval',
      at: '2026-09-18T20:10:00.000Z',
      data: { release: '218' },
    }));

    const rollout = store.listDerivedEvents({ name: 'rollout.allowed' });
    assert.equal(rollout.length, 1);
    assert.equal(rollout[0].event.data.repository, 'acme/app');
    assert.equal(rollout[0].rootEvidence.length, 3);
    assert.deepEqual(
      rollout[0].rootEvidence.map((item) => item.sourceEventId).sort(),
      ['approval_218', 'deploy_218', 'pr_218'],
    );

    const finalMatch = store.listTriggerMatches('runtime-final')[0];
    assert.equal(finalMatch.status, 'fired');
    assert.equal(
      store.getTriggerState('runtime-final', '1').status,
      'completed',
    );

    assert.equal(approvalResult.derivedEvents.length, 1);
    assert.equal(
      approvalResult.derivedEvents[0].eventName,
      'rollout.allowed',
    );

    const persistedWake = store.latestWake(finalMatch.firedWakeId);
    assert.ok(persistedWake);
    assert.equal(persistedWake.status, 'delivered');
    assert.match(persistedWake.runtimeReceiptId, /^receipt:wake_/);

    const beforeReplayDerivedCount = store.listDerivedEvents().length;
    const beforeReplayWake = store.latestWake(finalMatch.firedWakeId);

    await consumer.ingestCorrelatable(event({
      id: 'approval_218',
      name: 'manager.approved',
      serverId: 'approval',
      at: '2026-09-18T20:10:00.000Z',
      data: { release: '218' },
    }));

    assert.equal(store.listDerivedEvents().length, beforeReplayDerivedCount);
    assert.deepEqual(store.latestWake(finalMatch.firedWakeId), beforeReplayWake);

    const restored = new PersistentEventStore(dir);
    const counts = await restored.init();
    assert.equal(counts.derivedEvents, 2);
    assert.equal(
      restored.listDerivedEvents({ name: 'rollout.allowed' })[0]
        .rootEvidence.length,
      3,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('derived event graph rejects A -> B -> A cycles', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc020-cycle-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);

    await engine.register({
      triggerId: 'a-to-b',
      version: '1',
      clauses: [{
        id: 'a',
        event: 'fact.a',
        serverId: DERIVED_EVENT_SERVER_ID,
        where: [],
      }],
      expression: { kind: 'anyOf', refs: ['a'] },
      withinMs: 3600000,
      derivedEvent: {
        name: 'fact.b',
        contractVersion: '1',
      },
    });

    await assert.rejects(
      () => engine.register({
        triggerId: 'b-to-a',
        version: '1',
        clauses: [{
          id: 'b',
          event: 'fact.b',
          serverId: DERIVED_EVENT_SERVER_ID,
          where: [],
        }],
        expression: { kind: 'anyOf', refs: ['b'] },
        withinMs: 3600000,
        derivedEvent: {
          name: 'fact.a',
          contractVersion: '1',
        },
      }),
      (error) => error.code === 'TRIGGER_DERIVED_EVENT_CYCLE',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('derived fan-out has a hard recursion depth guard', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc020-depth-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);

    await engine.register({
      triggerId: 'depth-1',
      version: '1',
      clauses: [{
        id: 'start',
        event: 'start',
        serverId: 'provider',
        where: [],
      }],
      expression: { kind: 'anyOf', refs: ['start'] },
      withinMs: 3600000,
      derivedEvent: { name: 'depth.one', contractVersion: '1' },
    });
    await engine.register({
      triggerId: 'depth-2',
      version: '1',
      clauses: [{
        id: 'one',
        event: 'depth.one',
        serverId: DERIVED_EVENT_SERVER_ID,
        where: [],
      }],
      expression: { kind: 'anyOf', refs: ['one'] },
      withinMs: 3600000,
      derivedEvent: { name: 'depth.two', contractVersion: '1' },
    });

    await store.putDerivedContract({
      eventName: 'depth.one',
      contractVersion: '1',
      payloadSchema: {},
      schemaFingerprint: 'a'.repeat(64),
      producers: [{ triggerId: 'depth-1', triggerVersion: '1' }],
    });
    await store.putDerivedContract({
      eventName: 'depth.two',
      contractVersion: '1',
      payloadSchema: {},
      schemaFingerprint: 'b'.repeat(64),
      producers: [{ triggerId: 'depth-2', triggerVersion: '1' }],
    });

    const consumer = new CompositeEventConsumer({
      store,
      triggerEngine: engine,
      derivedEventCoordinator: new DerivedEventCoordinator({ store }),
      maxDerivedDepth: 1,
    });

    await assert.rejects(
      () => consumer.ingestCorrelatable(event({
        id: 'depth_start',
        name: 'start',
        serverId: 'provider',
        at: '2026-09-18T20:00:00.000Z',
      })),
      (error) => error.code === 'DERIVED_EVENT_CHAIN_DEPTH_EXCEEDED',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
