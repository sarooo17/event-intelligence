import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SemanticConditionEngine,
  projectSemanticInput,
} from '../dist/src/semantic/conditionEngine.js';

test('semantic projection only exposes explicitly selected fields', () => {
  const projected = projectSemanticInput(
    {
      data: {
        title: 'Signup is blocked',
        privateBody: 'secret',
      },
    },
    ['data.title'],
  );

  assert.deepEqual(projected, { 'data.title': 'Signup is blocked' });
  assert.equal(Object.hasOwn(projected, 'data.privateBody'), false);
});

test('confidence policy distinguishes match, reject and uncertain escalation', async () => {
  const probabilities = [0.95, 0.05, 0.6];
  const evaluator = {
    async evaluate() {
      return {
        evaluator: 'test-evaluator',
        probability: probabilities.shift(),
      };
    },
  };
  const engine = new SemanticConditionEngine(evaluator);
  const condition = {
    type: 'semantic_boolean',
    instruction: 'relevant',
    input: ['data.title'],
    matchThreshold: 0.8,
    rejectThreshold: 0.2,
    uncertain: 'escalate',
  };

  const match = await engine.evaluate({ data: { title: 'a' } }, condition);
  const reject = await engine.evaluate({ data: { title: 'b' } }, condition);
  const uncertain = await engine.evaluate({ data: { title: 'c' } }, condition);

  assert.equal(match.outcome, 'match');
  assert.equal(match.matched, true);
  assert.equal(reject.outcome, 'reject');
  assert.equal(reject.matched, false);
  assert.equal(uncertain.outcome, 'uncertain');
  assert.equal(uncertain.shouldEscalate, true);
});

test('invalid evaluator probability fails closed', async () => {
  const engine = new SemanticConditionEngine({
    async evaluate() {
      return { evaluator: 'broken', probability: 1.5 };
    },
  });

  await assert.rejects(
    () => engine.evaluate(
      { data: { title: 'x' } },
      {
        type: 'semantic_boolean',
        instruction: 'relevant',
        input: ['data.title'],
        matchThreshold: 0.8,
        rejectThreshold: 0.2,
        uncertain: 'escalate',
      },
    ),
    /probability must be between 0 and 1/,
  );
});
