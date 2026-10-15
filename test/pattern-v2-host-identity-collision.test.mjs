import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { PatternAstV2DefinitionSchema, evaluatePatternV2, patternV2CandidateSignature } from '../dist/src/intelligenceProtocol/index.js';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';

const pattern = PatternAstV2DefinitionSchema.parse({
  version: '2',
  root: {
    kind: 'threshold', ref: 'item', atLeast: 2,
    child: { kind: 'event', ref: 'item' },
  },
  partitionBy: [],
  selection: {
    overlap: 'disallow', afterMatch: 'keepAll', maxMatchesPerEvent: 10,
  },
  execution: {
    maxCandidates: 16, maxSemanticEvaluations: 0, maxBufferedEvents: 1,
  },
});

test('host buffer cap counts delimiter-colliding physical sources separately', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-host-physical-collision-'));
  let store;
  try {
    store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    await engine.register({
      triggerId: 'host-collision-buffer-cap',
      version: '1',
      conditionOnly: true,
      clauses: [{
        id: 'item', event: 'item.event', where: [], arguments: {},
      }],
      pattern,
      withinMs: 3600000,
    });
    const first = {
      traceId: 'physical:first',
      sourceEventId: 'c',
      name: 'item.event',
      occurredAt: '2026-10-15T10:00:00.000Z',
      serverId: 'a:b',
      provider: 'synthetic',
      subscriptionArguments: {},
      data: {},
    };
    const second = {
      ...first,
      traceId: 'physical:second',
      sourceEventId: 'b:c',
      serverId: 'a',
      occurredAt: '2026-10-15T10:01:00.000Z',
    };
    const initial = await engine.ingest(first);
    assert.ok(initial.length >= 1);
    await assert.rejects(
      engine.ingest(second),
      err => err?.code === 'PATTERN_V2_BUFFER_LIMIT_EXCEEDED',
      'distinct source/server tuples must exceed a physical-event cap of one',
    );
    const overflows = store.listAudit().filter(a => a.kind === 'event.buffer_overflow');
    assert.equal(overflows.length, 1);
    assert.equal(overflows[0].details.bufferedEvents, 2);
    assert.equal(overflows[0].details.maxBufferedEvents, 1);
    assert.equal(await store.verifyAudit(), true);
  } finally {
    try { await store?.close(); } finally {
      await rm(dir,{recursive:true,force:true});
    }
  }
});

test('persisted candidate signature uses locale-independent code-unit tuple order', async () => {
  const exactTime = '2026-10-15T12:00:00.000Z';
  const eventFor = sourceEventId => ({
    clauseId: 'item',
    traceId: 'locale-independent:' + sourceEventId,
    sourceEventId,
    eventName: 'item.event',
    occurredAt: exactTime,
    serverId: 'fixture',
    provider: 'synthetic',
    subscriptionArguments: {},
    data: {},
  });
  const definition = PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: {
      kind: 'repeat', min: 2, max: 2, mode: 'greedy',
      contiguity: 'combinations', child: { kind: 'event', ref: 'item' },
    },
    partitionBy: [],
    selection: {
      overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 10,
    },
    execution: {
      maxCandidates: 16, maxSemanticEvaluations: 0, maxBufferedEvents: 16,
    },
  });
  const events = [eventFor('Å'), eventFor('z')];
  const signatures = [];
  for (const delivery of [events, [...events].reverse()]) {
    const result = await evaluatePatternV2({definition,events:delivery});
    assert.equal(result.matches.length,1);
    assert.equal(result.truncated,false);
    signatures.push(patternV2CandidateSignature(result.matches[0]));
  }
  const expected = JSON.stringify([
    ['item', JSON.stringify(['fixture','z',{}])],
    ['item', JSON.stringify(['fixture','Å',{}])],
  ]);
  assert.deepEqual(signatures,[expected,expected],
    'signature ordering must not depend on host locale or delivery order');
});
