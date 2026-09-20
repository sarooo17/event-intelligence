import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TypeSafeJevEvaluator,
} from '../dist/src/semantic/typesafeJevEvaluator.js';
import {
  SemanticConditionEngine,
} from '../dist/src/semantic/conditionEngine.js';

test('Jev adapter sends documented System One noul request and maps probability', async () => {
  const calls = [];

  const evaluator = new TypeSafeJevEvaluator({
    apiKey: 'test-key',
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), init });

      return new Response(
        JSON.stringify({
          model: 'jev-test',
          answers: {
            match: {
              type: 'noul',
              noul: 0.93,
            },
          },
          usage: {
            input_tokens: 21,
            output_tokens: 4,
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'x-request-id': 'req_test_123',
          },
        },
      );
    },
  });

  const result = await evaluator.evaluate({
    instruction: 'The issue concerns user onboarding friction.',
    input: {
      'data.title': 'Signup is blocked after verification',
    },
  });

  assert.equal(result.probability, 0.93);
  assert.equal(result.evaluator, 'typesafe/jev-test');
  assert.equal(result.metadata.inputTokens, 21);
  assert.equal(result.metadata.outputTokens, 4);
  assert.equal(result.metadata.httpStatus, 200);
  assert.equal(result.metadata.requestId, 'req_test_123');
  assert.equal(result.metadata.resolvedModel, 'jev-test');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://api.typesafe.ai/v1/systemone',
  );
  assert.equal(
    calls[0].init.headers.Authorization,
    'Bearer test-key',
  );

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.state, {
    'data.title': 'Signup is blocked after verification',
  });
  assert.deepEqual(body.questions, {
    match: {
      type: 'noul',
      instructions: 'The issue concerns user onboarding friction.',
    },
  });
});

test('Jev adapter composes unchanged with SemanticConditionEngine', async () => {
  const evaluator = new TypeSafeJevEvaluator({
    apiKey: 'test-key',
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          model: 'jev-test',
          answers: {
            match: {
              type: 'noul',
              noul: 0.96,
            },
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  });

  const engine = new SemanticConditionEngine(evaluator);
  const decision = await engine.evaluate(
    {
      data: {
        title: 'Signup flow blocks activation',
      },
    },
    {
      type: 'semantic_boolean',
      instruction: 'The issue concerns onboarding.',
      input: ['data.title'],
      matchThreshold: 0.8,
      rejectThreshold: 0.2,
      uncertain: 'escalate',
    },
  );

  assert.equal(decision.outcome, 'match');
  assert.equal(decision.matched, true);
  assert.equal(decision.probability, 0.96);
  assert.equal(decision.metadata.resolvedModel, 'jev-test');
  assert.equal(decision.metadata.httpStatus, 200);
});

test('Jev adapter retries documented 429 rate-limit response', async () => {
  let calls = 0;

  const evaluator = new TypeSafeJevEvaluator({
    apiKey: 'test-key',
    retryBaseMs: 1,
    maxRetries: 2,
    fetchFn: async () => {
      calls += 1;

      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: 'rate limited' }),
          {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      return new Response(
        JSON.stringify({
          model: 'jev-test',
          answers: {
            match: {
              type: 'noul',
              noul: 0.1,
            },
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  });

  const result = await evaluator.evaluate({
    instruction: 'Relevant?',
    input: { title: 'routine update' },
  });

  assert.equal(calls, 2);
  assert.equal(result.probability, 0.1);
});
