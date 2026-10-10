import assert from 'node:assert/strict';
import test from 'node:test';
import { readOwnEventPath, snapshotUntrustedEventData } from '../dist/src/protocol/ownPath.js';
import { parseCorrelatableEvent } from '../dist/src/intelligenceProtocol/triggerSchemas.js';
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

test('ingress snapshots payload before a schema parser can execute event getters', () => {
  let invoked = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'tenant', {
    enumerable: true,
    get() { invoked++; return 'victim'; },
  });
  assert.throws(
    () => parseCorrelatableEvent(occurrence(hostile)),
    error => error.code === 'EVENT_UNTRUSTED_DATA_INVALID',
  );
  assert.equal(invoked, 0, 'Zod record traversal must not invoke accessor');
  const clean = parseCorrelatableEvent(occurrence({ tenant: 'victim' }));
  assert.equal(clean.data.tenant, 'victim');
});

test('terminal array values cannot see inherited indices or element accessors', () => {
  const inherited = new Array(1);
  const maliciousPrototype = Object.create(Array.prototype);
  Object.defineProperty(maliciousPrototype, '0', {
    enumerable: true, value: 'admin',
  });
  Object.setPrototypeOf(inherited, maliciousPrototype);
  assert.equal(inherited.includes('admin'), true, 'fixture proves the inherited array-index bypass');
  assert.equal(readOwnEventPath({ roles: inherited }, 'roles'), undefined);
  assert.equal(clauseMatches(clause('roles', 'contains', 'admin'),
    occurrence({ roles: inherited })), false);
  assert.throws(
    () => snapshotUntrustedEventData({ roles: inherited }),
    error => error.code === 'EVENT_UNTRUSTED_DATA_INVALID',
  );
  let invoked = 0;
  const accessor = [];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    get() { invoked++; return 'admin'; },
  });
  assert.equal(readOwnEventPath({ roles: accessor }, 'roles'), undefined);
  assert.throws(
    () => parseCorrelatableEvent(occurrence({ roles: accessor })),
    error => error.code === 'EVENT_UNTRUSTED_DATA_INVALID',
  );
  assert.equal(invoked, 0);
  assert.deepEqual(readOwnEventPath({ roles: ['admin'] }, 'roles'), ['admin']);
});

test('event Proxy traps are rejected before ownKeys, descriptors or accessors run', () => {
  let traps = 0;
  const forged = new Proxy({ tenant: 'victim' }, {
    ownKeys() { traps++; return ['tenant']; },
    getOwnPropertyDescriptor() {
      traps++;
      return { configurable: true, enumerable: true, value: 'victim' };
    },
    get() { traps++; return 'victim'; },
  });
  assert.throws(
    () => parseCorrelatableEvent(occurrence({ account: forged })),
    error => error.code === 'EVENT_UNTRUSTED_DATA_INVALID',
    'nested proxy must fail before Zod parsing',
  );
  assert.equal(readOwnEventPath({ account: forged }, 'account.tenant'), undefined);
  assert.equal(readOwnEventPath({ account: forged }, 'account'), undefined);
  assert.equal(traps, 0, 'event evidence must not invoke any trap');

  const proxiedArray = new Proxy(['admin'], {
    get() { traps++; return 'admin'; },
    ownKeys() { traps++; return ['0', 'length']; },
    getOwnPropertyDescriptor() { traps++; return { enumerable: true, value: 'admin', configurable: true }; },
  });
  assert.throws(
    () => snapshotUntrustedEventData({ roles: proxiedArray }),
    error => error.code === 'EVENT_UNTRUSTED_DATA_INVALID',
  );
  assert.equal(readOwnEventPath({ roles: proxiedArray }, 'roles'), undefined);
  assert.equal(traps, 0, 'array proxy must be rejected without reading length');

  const topLevel = new Proxy(occurrence({ tenant: 'victim' }), {
    ownKeys() { traps++; return ['data']; },
  });
  assert.throws(
    () => parseCorrelatableEvent(topLevel),
    error => error.code === 'EVENT_UNTRUSTED_DATA_INVALID',
  );
  assert.equal(traps, 0, 'top-level event proxy also must be rejected');
});
