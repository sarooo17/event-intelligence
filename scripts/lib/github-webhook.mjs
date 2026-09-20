import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGitHubWebhookSignature(rawBody, signature, secret) {
  if (!secret || !signature?.startsWith('sha256=')) return false;

  const expected = createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const actual = signature.slice('sha256='.length);

  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(actual, 'hex');

  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function translateGitHubWebhook({
  eventName,
  deliveryId,
  payload,
}) {
  if (eventName === 'ping') {
    return { kind: 'ping' };
  }

  if (eventName !== 'issues') {
    return { kind: 'ignored', reason: 'unsupported_event' };
  }

  const action = String(payload.action ?? '');
  if (!['opened', 'reopened', 'edited', 'closed'].includes(action)) {
    return { kind: 'ignored', reason: 'unsupported_action' };
  }

  const issue = payload.issue;
  const repository = payload.repository;
  if (!issue || !repository?.full_name || !deliveryId) {
    throw new Error('Invalid GitHub issues webhook payload');
  }

  return {
    kind: 'event',
    event: {
      eventId: deliveryId,
      name: `github.issue.${action}`,
      timestamp:
        issue.updated_at ??
        issue.created_at ??
        new Date().toISOString(),
      data: {
        repository: repository.full_name,
        number: issue.number,
        title: issue.title ?? '',
        bodyPreview:
          typeof issue.body === 'string'
            ? issue.body.slice(0, 1000)
            : '',
        labels: Array.isArray(issue.labels)
          ? issue.labels
              .map((label) =>
                typeof label === 'string' ? label : label?.name,
              )
              .filter(Boolean)
          : [],
        sender: payload.sender?.login ?? null,
        action,
        url: issue.html_url ?? null,
      },
      cursor: null,
    },
  };
}

export function githubEventPassesStructuredFilter(
  event,
  { repository, label } = {},
) {
  if (repository && event.data.repository !== repository) return false;
  if (
    label &&
    (!Array.isArray(event.data.labels) ||
      !event.data.labels.includes(label))
  ) {
    return false;
  }
  return true;
}
