import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { PatternAstV2DefinitionSchema } from '../dist/src/intelligenceProtocol/index.js';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';

const triggerId = 'partition-restart-equivalence';
const definition = PatternAstV2DefinitionSchema.parse({
  version: '2',
  root: {
    kind: 'sequence',
    contiguity: 'followedBy',
    children: [
      { kind: 'event', ref: 'order' },
      { kind: 'event', ref: 'payment' },
    ],
  },
  partitionBy: [{
    key: 'customer',
    fields: [
      { ref: 'order', path: 'customer' },
      { ref: 'payment', path: 'customer' },
    ],
  }],
  selection: {
    overlap: 'disallow', afterMatch: 'skipPastLast', maxMatchesPerEvent: 10,
  },
  execution: {
    maxCandidates: 64, maxSemanticEvaluations: 0, maxBufferedEvents: 64,
  },
});

function interleaved(seed) {
  let state = (Math.imul(seed, 2654435761) ^ 0xa21fb329) >>> 0;
  const queues = [
    { tenant: 'A', refs: ['order', 'payment'] },
    { tenant: 'B', refs: ['order', 'payment'] },
    { tenant: 'C', refs: ['order'] },
  ].map(queue => ({ ...queue, next: 0 }));
  const events = [];
  while (queues.some(queue => queue.next < queue.refs.length)) {
    const eligible = queues.filter(queue => queue.next < queue.refs.length);
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const queue = eligible[state % eligible.length];
    const ref = queue.refs[queue.next++];
    const index = events.length;
    events.push({
      traceId: 'trace:partition:' + seed + ':' + index,
      sourceEventId: 'partition:' + seed + ':' + queue.tenant + ':' + ref,
      name: ref === 'order' ? 'order.created' : 'payment.completed',
      occurredAt: new Date(Date.UTC(2026, 9, 14, 12, 0, index)).toISOString(),
      serverId: 'synthetic-mcp-server',
      provider: 'partition-oracle',
      subscriptionArguments: {},
      data: { customer: queue.tenant },
    });
  }
  return events;
}

// Pure finite reference model: there is exactly one order and one later
// payment for A and B, and only an unmatched order for C.
function referencePairs(events) {
  const groups = new Map();
  for (const event of events) {
    const tenant = event.data.customer;
    const bucket = groups.get(tenant) ?? [];
    bucket.push(event);
    groups.set(tenant, bucket);
  }
  const result = [];
  for (const [tenant, group] of groups) {
    const order = group.find(event => event.name === 'order.created');
    const payment = group.find(event => event.name === 'payment.completed');
    if (order && payment &&
        Date.parse(order.occurredAt) < Date.parse(payment.occurredAt)) {
      result.push(tenant + ':' + order.sourceEventId + '|' + payment.sourceEventId);
    }
  }
  return result.sort();
}

async function run(seed, stopAt) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-cep-partition-eq-'));
  let store;
  const events = interleaved(seed);
  try {
    store = new PersistentEventStore(dir);
    await store.init();
    let engine = new CompositeTriggerEngine(store);
    await engine.register({
      triggerId, version: '1',
      conditionOnly: true,
      clauses: [
        { id: 'order', event: 'order.created', where: [], arguments: {} },
        { id: 'payment', event: 'payment.completed', where: [], arguments: {} },
      ],
      pattern: definition,
      withinMs: 3600000,
    });

    for (let i = 0; i < events.length; i++) {
      if (i === stopAt) {
        // Real JSONL close/open and freshly constructed engine; no
        // long-lived process cache shared across the continuity boundary.
        await store.close();
        store = new PersistentEventStore(dir);
        await store.init();
        engine = new CompositeTriggerEngine(store);
      }
      await engine.ingest(events[i]);
    }

    const selected = () => store.listTriggerMatches(triggerId)
      .filter(match => match.patternState?.role === 'match')
      .map(match => {
        assert.equal(match.sourceEvents.length, 2,
          'seed=' + seed + ' match must bind two events');
        const [order, payment] = match.sourceEvents;
        assert.equal(order.name, 'order.created');
        assert.equal(payment.name, 'payment.completed');
        const customer = order.data.customer;
        assert.equal(payment.data.customer, customer,
          'never correlate across partition customer keys');
        return customer + ':' +
          order.sourceEventId + '|' + payment.sourceEventId;
      }).sort();

    const expected = referencePairs(events);
    assert.equal(expected.length, 2, 'fixture must contain two independent pairs');
    assert.deepEqual(selected(), expected, 'seed=' + seed + ' stopAt=' + stopAt);

    // Replaying the same occurrence cannot append a new logical match.
    await engine.ingest(events[0]);
    assert.deepEqual(selected(), expected,
      'seed=' + seed + ' reingestion created a duplicate durable match');
    assert.equal(await store.verifyAudit(), true);

    // Check materialized durable results after a second independent reopen,
    // not merely in-memory state of the coordinator that ingested them.
    await store.close();
    store = new PersistentEventStore(dir);
    await store.init();
    assert.deepEqual(selected(), expected,
      'seed=' + seed + ' restored durable matches differ');
    return selected();
  } finally {
    try { await store?.close(); } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

test('32 deterministic interleavings preserve partition isolation and restart equivalence', {
  timeout: 60000,
}, async () => {
  const witnessOrders = new Set();
  for (let seed = 1; seed <= 32; seed++) {
    const events = interleaved(seed);
    witnessOrders.add(events.map(item =>
      item.data.customer + ':' + item.name).join(','));
    const uninterrupted = await run(seed, -1);
    const restarted = await run(seed, 2 + (seed % 2));
    assert.deepEqual(restarted, uninterrupted,
      'seed=' + seed + ' discontinuity across physical store reopen');
  }
  assert.ok(witnessOrders.size >= 5,
    'seed generator must exercise genuinely different interleavings');
});
