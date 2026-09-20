import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { CompositeEventConsumer } from '../scripts/lib/composite-event-consumer.mjs';
import {
  DerivedEventCoordinator,
  DERIVED_EVENT_CONNECTION_ID,
  DERIVED_EVENT_SERVER_ID,
} from '../scripts/lib/derived-event-coordinator.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { TriggerControlPlane } from '../scripts/lib/trigger-control-plane.mjs';

const actor = { type: 'user', principal_id: 'user_contracts' };

function baseSource(sourceId, eventName, fieldType = 'string') {
  return {
    sourceId,
    connectionId: 'inputs',
    serverId: 'inputs',
    eventName,
    enabled: true,
    delivery: ['internal'],
    payloadSchema: {
      type: 'object',
      properties: {
        entity: { type: fieldType },
      },
      required: ['entity'],
    },
  };
}

function producer({
  triggerId,
  inputEvent,
  contractVersion,
  constants = { readiness: 'stable' },
}) {
  return {
    triggerId,
    version: '1',
    clauses: [{
      id: 'input',
      event: inputEvent,
      serverId: 'inputs',
      where: [],
    }],
    expression: { kind: 'anyOf', refs: ['input'] },
    withinMs: 3600000,
    derivedEvent: {
      name: 'release.ready',
      contractVersion,
      projections: [
        { key: 'entity', ref: 'input', path: 'entity' },
      ],
      constants,
    },
  };
}

function consumer({
  triggerId,
  contractVersion,
}) {
  return {
    triggerId,
    version: '1',
    clauses: [{
      id: 'release',
      event: 'release.ready',
      serverId: DERIVED_EVENT_SERVER_ID,
      ...(contractVersion ? { contractVersion } : {}),
      where: [],
    }],
    expression: { kind: 'anyOf', refs: ['release'] },
    withinMs: 3600000,
    target: {
      runtime: 'unconfigured-test-runtime',
      kind: 'task',
      id: triggerId,
    },
  };
}

function inputEvent(name, id, entity) {
  return {
    traceId: `trace_${id}`,
    sourceEventId: id,
    name,
    serverId: 'inputs',
    provider: 'test',
    occurredAt: '2026-09-18T22:00:00.000Z',
    data: { entity },
  };
}

test('contract registry accepts compatible producers, rejects incompatible same-version schema, and survives restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc021-contracts-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    const control = new TriggerControlPlane({ store, triggerEngine: engine });

    await control.registerEventSource(baseSource('src_a', 'source.a'), actor);
    await control.registerEventSource(baseSource('src_b', 'source.b'), actor);
    await control.registerEventSource(baseSource('src_c', 'source.c'), actor);
    await control.registerEventSource(baseSource('src_v2', 'source.v2'), actor);

    await control.createTrigger({
      definition: producer({
        triggerId: 'producer-a',
        inputEvent: 'source.a',
        contractVersion: '1',
      }),
      connectionIds: ['inputs'],
      actor,
      owner: actor,
    });

    const v1 = store.getDerivedContract('release.ready', '1');
    assert.ok(v1);
    assert.equal(v1.producers.length, 1);
    assert.match(v1.schemaFingerprint, /^[a-f0-9]{64}$/);

    await control.createTrigger({
      definition: producer({
        triggerId: 'producer-b',
        inputEvent: 'source.b',
        contractVersion: '1',
      }),
      connectionIds: ['inputs'],
      actor,
      owner: actor,
    });

    const joined = store.getDerivedContract('release.ready', '1');
    assert.equal(joined.producers.length, 2);
    assert.equal(joined.schemaFingerprint, v1.schemaFingerprint);

    await assert.rejects(
      () => control.createTrigger({
        definition: producer({
          triggerId: 'producer-conflict',
          inputEvent: 'source.c',
          contractVersion: '1',
          constants: {
            readiness: 'stable',
            severity: 2,
          },
        }),
        connectionIds: ['inputs'],
        actor,
        owner: actor,
      }),
      (error) => error.code === 'DERIVED_CONTRACT_SCHEMA_CONFLICT',
    );

    assert.equal(
      store.listTriggers().some(
        (definition) => definition.triggerId === 'producer-conflict',
      ),
      false,
    );

    const conflictAudit = store.listAudit()
      .filter((record) => record.kind === 'derived_contract.conflict');
    assert.equal(conflictAudit.length, 1);

    // With one contract version, a legacy unversioned consumer resolves to @1
    await control.createTrigger({
      definition: consumer({
        triggerId: 'legacy-consumer',
      }),
      connectionIds: [DERIVED_EVENT_CONNECTION_ID],
      actor,
      owner: actor,
    });
    const storedLegacy = store.listTriggers()
      .find((definition) => definition.triggerId === 'legacy-consumer');
    assert.equal(storedLegacy.clauses[0].contractVersion, '1');

    await control.createTrigger({
      definition: producer({
        triggerId: 'producer-v2',
        inputEvent: 'source.v2',
        contractVersion: '2',
        constants: {
          readiness: 'stable',
          revision: 2,
        },
      }),
      connectionIds: ['inputs'],
      actor,
      owner: actor,
    });

    assert.equal(store.listDerivedContracts('release.ready').length, 2);

    await assert.rejects(
      () => control.createTrigger({
        definition: consumer({
          triggerId: 'ambiguous-consumer',
        }),
        connectionIds: [DERIVED_EVENT_CONNECTION_ID],
        actor,
        owner: actor,
      }),
      (error) => error.code === 'DERIVED_CONTRACT_AMBIGUOUS',
    );

    const restored = new PersistentEventStore(dir);
    const counts = await restored.init();
    assert.equal(counts.derivedContracts, 2);
    assert.equal(
      restored.getDerivedContract('release.ready', '1').schemaFingerprint,
      v1.schemaFingerprint,
    );
    assert.equal(
      restored.getDerivedContract('release.ready', '2').producers.length,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit v1/v2 consumers receive only matching derived contract occurrences', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc021-routing-'));
  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    const control = new TriggerControlPlane({ store, triggerEngine: engine });

    await control.registerEventSource(baseSource('src_v1', 'source.v1'), actor);
    await control.registerEventSource(baseSource('src_v2', 'source.v2'), actor);

    await control.createTrigger({
      definition: producer({
        triggerId: 'producer-v1',
        inputEvent: 'source.v1',
        contractVersion: '1',
      }),
      connectionIds: ['inputs'],
      actor,
      owner: actor,
    });

    await control.createTrigger({
      definition: producer({
        triggerId: 'producer-v2-routing',
        inputEvent: 'source.v2',
        contractVersion: '2',
        constants: { readiness: 'stable', revision: 2 },
      }),
      connectionIds: ['inputs'],
      actor,
      owner: actor,
    });

    await control.createTrigger({
      definition: consumer({
        triggerId: 'consumer-v1',
        contractVersion: '1',
      }),
      connectionIds: [DERIVED_EVENT_CONNECTION_ID],
      actor,
      owner: actor,
    });
    await control.createTrigger({
      definition: consumer({
        triggerId: 'consumer-v2',
        contractVersion: '2',
      }),
      connectionIds: [DERIVED_EVENT_CONNECTION_ID],
      actor,
      owner: actor,
    });

    const consumerEngine = new CompositeEventConsumer({
      store,
      triggerEngine: engine,
      derivedEventCoordinator: new DerivedEventCoordinator({ store }),
    });

    await consumerEngine.ingestCorrelatable(
      inputEvent('source.v1', 'input_v1', 'release-1'),
    );

    assert.equal(store.listTriggerMatches('consumer-v1').length, 1);
    assert.equal(store.listTriggerMatches('consumer-v2').length, 0);

    const emittedV1 = store.listDerivedEvents({ name: 'release.ready' })[0];
    assert.equal(emittedV1.event.data._derived.contractVersion, '1');
    assert.equal(
      emittedV1.event.data._derived.schemaFingerprint,
      store.getDerivedContract('release.ready', '1').schemaFingerprint,
    );

    await consumerEngine.ingestCorrelatable(
      inputEvent('source.v2', 'input_v2', 'release-2'),
    );

    assert.equal(store.listTriggerMatches('consumer-v1').length, 1);
    assert.equal(store.listTriggerMatches('consumer-v2').length, 1);

    const emitted = store.listDerivedEvents({ name: 'release.ready' });
    assert.deepEqual(
      emitted.map((record) => record.event.data._derived.contractVersion).sort(),
      ['1', '2'],
    );

    const sources = control.listEventSources({
      connectionIds: [DERIVED_EVENT_CONNECTION_ID],
    });
    assert.deepEqual(
      [...new Set(
        sources
          .filter((source) => source.eventName === 'release.ready')
          .map((source) => source.metadata.contractVersion),
      )].sort(),
      ['1', '2'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
