import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventProcessor } from '../scripts/lib/event-processor.mjs';
import {
  githubEventPassesStructuredFilter,
  translateGitHubWebhook,
  verifyGitHubWebhookSignature,
} from '../scripts/lib/github-webhook.mjs';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';

const fixedNow = () => new Date('2026-09-18T07:00:00.000Z');

function request(eventId = 'delivery_1') {
  return {
    event: {
      eventId,
      name: 'github.issue.opened',
      timestamp: '2026-09-18T06:59:59.000Z',
      data: {
        repository: 'acme/app',
        title: 'Signup blocks new users',
        bodyPreview: 'New users cannot continue after verification.',
        labels: ['onboarding'],
      },
      cursor: null,
    },
    context: {
      environmentId: 'env_test',
      subscriptionId: 'sub_github',
      serverId: 'github-webhook-adapter',
      transport: 'webhook',
      provider: 'github',
      target: {
        runtime: 'openai-agents',
        kind: 'session',
        id: 'session_onboarding',
      },
    },
    semanticCondition: {
      type: 'semantic_boolean',
      instruction: 'The issue concerns user onboarding friction.',
      input: ['data.title', 'data.bodyPreview'],
      matchThreshold: 0.8,
      rejectThreshold: 0.2,
      uncertain: 'escalate',
    },
  };
}

test('persistent processor restores dedup state and verifies audit chain after restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-ei-store-'));

  try {
    const evaluator = {
      async evaluate() {
        return {
          evaluator: 'test/semantic',
          probability: 0.96,
          metadata: {
            requestedModel: 'jev-latest',
            resolvedModel: 'jev-test',
            requestId: 'req_test_provider',
            httpStatus: 200,
            inputTokens: 42,
            outputTokens: 7,
            cost: 0.001,
          },
        };
      },
    };

    const firstStore = new PersistentEventStore(dir);
    await firstStore.init();
    const firstProcessor = new EventProcessor({
      store: firstStore,
      evaluator,
      now: fixedNow,
    });

    const first = await firstProcessor.ingest(request());
    assert.equal(first.status, 'wake_queued');
    assert.equal(first.decision.outcome, 'match');
    assert.equal(first.decision.providerEvidence.resolvedModel, 'jev-test');
    assert.equal(first.decision.providerEvidence.inputTokens, 42);
    assert.equal(first.decision.providerEvidence.requestId, 'req_test_provider');
    assert.equal(await firstStore.verifyAudit(), true);

    const duplicate = await firstProcessor.ingest(request());
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(await firstStore.verifyAudit(), true);

    const traceId = first.traceId;
    const trace = firstStore.trace(traceId);
    assert.equal(trace.events.length, 1);
    assert.equal(trace.decisions.length, 1);
    assert.equal(trace.decisions[0].providerEvidence.resolvedModel, 'jev-test');
    assert.equal(trace.decisions[0].providerEvidence.outputTokens, 7);
    assert.equal(trace.wakes.length, 1);
    assert.ok(trace.audit.length >= 5);

    const secondStore = new PersistentEventStore(dir);
    const restored = await secondStore.init();
    assert.equal(restored.events, 1);
    assert.equal(restored.decisions, 1);
    assert.equal(restored.wakes, 1);
    assert.equal(await secondStore.verifyAudit(), true);

    const secondProcessor = new EventProcessor({
      store: secondStore,
      evaluator,
      now: fixedNow,
    });

    const duplicateAfterRestart = await secondProcessor.ingest(request());
    assert.equal(duplicateAfterRestart.status, 'duplicate');
    assert.equal(await secondStore.verifyAudit(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('wake delivery and acknowledgement stay linked to one trace', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-ei-wake-'));

  try {
    const store = new PersistentEventStore(dir);
    await store.init();

    const processor = new EventProcessor({
      store,
      evaluator: {
        async evaluate() {
          return { evaluator: 'test/semantic', probability: 0.99 };
        },
      },
      wakeDeliverer: async () => ({
        runtimeReceiptId: 'runtime_receipt_1',
      }),
      now: fixedNow,
    });

    const result = await processor.ingest(request('delivery_2'));
    assert.equal(result.status, 'wake_delivered');
    assert.equal(result.wake.runtimeReceiptId, 'runtime_receipt_1');

    const handled = await processor.acknowledgeWake(
      result.wake.wakeId,
      'runtime_receipt_1',
    );
    assert.equal(handled.status, 'handled');

    const trace = store.trace(result.traceId);
    assert.equal(trace.wakes.at(-1).status, 'handled');
    assert.equal(await store.verifyAudit(), true);

    const transitions = trace.audit
      .filter((record) => record.toState)
      .map((record) => record.toState);

    assert.ok(transitions.includes('wake_queued'));
    assert.ok(transitions.includes('wake_delivered'));
    assert.ok(transitions.includes('handled'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GitHub webhook signature and adapter preserve delivery ID as source event ID', () => {
  const secret = 'github-test-secret';
  const raw = Buffer.from(
    JSON.stringify({
      action: 'opened',
      issue: {
        number: 42,
        title: 'Signup issue',
        body: 'Verification loops forever',
        created_at: '2026-09-18T07:00:00.000Z',
        updated_at: '2026-09-18T07:00:00.000Z',
        labels: [{ name: 'onboarding' }],
        html_url: 'https://github.com/acme/app/issues/42',
      },
      repository: {
        full_name: 'acme/app',
      },
      sender: {
        login: 'example-user',
      },
    }),
  );

  const signature =
    'sha256=' +
    createHmac('sha256', secret).update(raw).digest('hex');

  assert.equal(
    verifyGitHubWebhookSignature(raw, signature, secret),
    true,
  );
  assert.equal(
    verifyGitHubWebhookSignature(raw, 'sha256=deadbeef', secret),
    false,
  );

  const translated = translateGitHubWebhook({
    eventName: 'issues',
    deliveryId: 'github_delivery_123',
    payload: JSON.parse(raw.toString('utf8')),
  });

  assert.equal(translated.kind, 'event');
  assert.equal(translated.event.eventId, 'github_delivery_123');
  assert.equal(translated.event.name, 'github.issue.opened');
  assert.equal(
    githubEventPassesStructuredFilter(translated.event, {
      repository: 'acme/app',
      label: 'onboarding',
    }),
    true,
  );
  assert.equal(
    githubEventPassesStructuredFilter(translated.event, {
      repository: 'acme/app',
      label: 'security',
    }),
    false,
  );
});
