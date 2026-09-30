import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  githubEventPassesStructuredFilter,
  translateGitHubWebhook,
  verifyGitHubWebhookSignature,
} from '../scripts/lib/github-webhook.mjs';

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
      repository: { full_name: 'acme/app' },
      sender: { login: 'example-user' },
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
});
