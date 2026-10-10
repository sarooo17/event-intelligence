import assert from 'node:assert/strict';
import test from 'node:test';
import { readOwnEventPath } from '../dist/src/protocol/ownPath.js';
import { projectSemanticInput } from '../dist/src/semantic/conditionEngine.js';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clauseMatches } from '../dist/src/composite/matching.js';
import {
  PatternAstV2DefinitionSchema, evaluatePatternV2,
} from '../dist/src/intelligenceProtocol/index.js';

function occurrence(data, id = 'source-1') {
  return {
    traceId: 'trace:' + id, sourceEventId: id,
    name: 'fixture.received', eventName: 'fixture.received', clauseId: 'a',
    occurredAt: '2026-10-01T10:00:00.000Z',
    serverId: 'fixture', provider: 'security-test',
    subscriptionArguments: {}, data,
  };
}

function clause(path, op, value) {
  return {
    id: 'a', event: 'fixture.received', serverId: 'fixture',
    arguments: {}, where: [{ path, op, value }],
  };
}

test('untrusted event predicates do not see Object.prototype inheritance', () => {
  for (const inherited of ['constructor', 'toString', '__proto__']) {
    const c = clause(inherited, 'exists', true);
    assert.equal(clauseMatches(c, occurrence({})), false, inherited);
  }
  const own = JSON.parse('{"__proto__":{"tag":"real"}}');
  assert.equal(clauseMatches(clause('__proto__.tag', 'eq', 'real'), occurrence(own)),
    true, 'an explicitly owned JSON key remains accessible');
  const inherited = Object.create({ tag: 'untrusted-prototype' });
  assert.equal(clauseMatches(clause('tag', 'eq', 'untrusted-prototype'),
    occurrence(inherited)), false, 'custom prototype properties are not payload evidence');
  assert.equal(clauseMatches(clause('tag', 'eq', 'real'),
    occurrence({ tag: 'real' })), true);
});

test('Pattern AST v2 value selectors cannot match inherited prototype properties', async () => {
  const definition = PatternAstV2DefinitionSchema.parse({
    version: '2',
    root: {
      kind: 'compare', child: { kind: 'event', ref: 'a' },
      left: { kind: 'field', ref: 'a', path: '__proto__', select: 'last' },
      op: 'type', expectedType: 'object',
    },
    partitionBy: [],
    selection: {
      overlap: 'allow', afterMatch: 'keepAll', maxMatchesPerEvent: 10,
    },
    execution: {
      maxCandidates: 512, maxSemanticEvaluations: 0, maxBufferedEvents: 512,
    },
  });
  const noOwnKey = await evaluatePatternV2({
    definition, events: [occurrence({})],
    now: new Date('2026-10-01T10:01:00.000Z'),
  });
  assert.equal(noOwnKey.matches.length, 0);
  const withOwnKey = await evaluatePatternV2({
    definition, events: [occurrence(JSON.parse('{"__proto__":{"tag":"real"}}'), 'source-2')],
    now: new Date('2026-10-01T10:01:00.000Z'),
  });
  assert.equal(withOwnKey.matches.length, 1);
});

test('shared event path resolver cannot execute getters or traverse prototypes', () => {
  let invoked = 0;
  const nested = Object.create({ owner: 'foreign-tenant' });
  Object.defineProperty(nested, 'getter', {
    enumerable: true,
    get() { invoked++; return 'secret'; },
  });
  const event = { account: nested, ready: { verified: true } };
  assert.equal(readOwnEventPath(event, 'account.owner'), undefined);
  assert.equal(readOwnEventPath(event, 'account.getter'), undefined);
  assert.equal(invoked, 0, 'field lookup must not execute attacker-controlled getters');
  assert.equal(readOwnEventPath(event, 'ready.verified'), true);
  assert.equal(readOwnEventPath(JSON.parse('{"__proto__":{"allowed":true}}'), '__proto__.allowed'), true);
});

test('semantic projections cannot pass inherited or accessor-derived evidence to a model', () => {
  let invoked = 0;
  const payload = Object.create({ flag: 'privileged' });
  Object.defineProperty(payload, 'secret', {
    get() { invoked++; return 'should-never-be-read'; },
  });
  payload.actual = 'owned';
  const projection = projectSemanticInput({ a: { payload } }, [
    'a.payload.flag', 'a.payload.secret', 'a.payload.actual',
  ]);
  assert.equal(projection['a.payload.flag'], undefined);
  assert.equal(projection['a.payload.secret'], undefined);
  assert.equal(projection['a.payload.actual'], 'owned');
  assert.equal(invoked, 0);
});

test('Pattern partition fields do not correlate synthetic inherited tenant identity', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-own-partition-'));
  try {
    const store = new PersistentEventStore(dataDir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);
    const pattern = PatternAstV2DefinitionSchema.parse({
      version: '2',
      root: {
        kind: 'sequence', contiguity: 'followedBy',
        children: [{ kind: 'event', ref: 'order' }, { kind: 'event', ref: 'payment' }],
      },
      partitionBy: [{
        key: 'tenant',
        fields: [
          { ref: 'order', path: 'account.tenant' },
          { ref: 'payment', path: 'account.tenant' },
        ],
      }],
    });
    await engine.register({
      triggerId: 'untrusted-partition', version: '1', conditionOnly: true,
      clauses: [
        { id: 'order', event: 'fixture.order', arguments: {}, where: [] },
        { id: 'payment', event: 'fixture.payment', arguments: {}, where: [] },
      ],
      pattern, withinMs: 3600_000,
    });
    const ingest = (id, name, data, minute) => engine.ingest({
      traceId: 'trace-' + id, sourceEventId: id, name,
      serverId: 'fixture', provider: 'test',
      occurredAt: `2026-10-01T10:0${minute}:00.000Z`,
      subscriptionArguments: {}, data,
    });
    const initial = await ingest('order-1', 'fixture.order',
      { account: { tenant: 'victim' } }, 0);
    assert.equal(initial.some(row => row.matched), false);
    const inherited = Object.create({ tenant: 'victim' });
    await assert.rejects(
      () => ingest('payment-inherited', 'fixture.payment',
        { account: inherited }, 1),
      /partition tenant resolved to a non-scalar value/,
      'undefined inherited partition data must fail closed, not correlate as victim',
    );
    const allowed = await ingest('payment-owned', 'fixture.payment',
      { account: { tenant: 'victim' } }, 2);
    assert.equal(allowed.some(row => row.matched), true,
      'legitimate own JSON partition data still matches');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
