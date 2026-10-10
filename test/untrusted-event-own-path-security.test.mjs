import assert from 'node:assert/strict';
import test from 'node:test';
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
