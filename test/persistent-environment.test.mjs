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
  // Node's lenient hex decoder previously discarded non-hex suffixes and
  // incomplete nibbles. None of these malformed wire signatures may pass
  // even when the preceding 64 hex characters contain the correct MAC.
  for (const malformed of [
    signature + 'junk',
    signature + 'f',
    signature + '\\n',
    signature + ' ',
    signature.replace('sha256=', 'SHA256='),
    signature.replace('sha256=', 'sha256=0'),
    'sha256=' + signature.slice(7).toUpperCase(),
    'sha256=' + signature.slice(7, -2) + 'gg',
    'sha256=' + signature.slice(7, -1),
    'sha256=' + signature.slice(7) + '00',
    '',
    null,
    undefined,
  ]) {
    assert.equal(
      verifyGitHubWebhookSignature(raw, malformed, secret),
      false,
      'malformed HMAC header accepted: ' + String(malformed),
    );
  }
  assert.equal(
    verifyGitHubWebhookSignature(Buffer.from('tampered'), signature, secret),
    false,
    'valid HMAC must be bound to the raw payload',
  );
  assert.equal(
    verifyGitHubWebhookSignature(raw, signature, ''),
    false,
    'a missing configured secret must fail closed',
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
