import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CompositeTriggerEngine } from '../dist/src/composite/engine.js';
import {
  CompositeTriggerDefinitionSchema,
} from '../dist/src/intelligenceProtocol/index.js';
import { PersistentEventStore } from '../scripts/lib/persistent-event-store.mjs';

function event({
  id,
  name,
  at,
  data,
  provider,
  serverId,
}) {
  return {
    traceId: `trace_${id}`,
    sourceEventId: id,
    name,
    occurredAt: at,
    ...(provider ? { provider } : {}),
    ...(serverId ? { serverId } : {}),
    data,
  };
}

function issueMailTrigger() {
  return {
    protocolVersion: '0.1.0',
    schemaVersion: 'trigger.v0.1',
    triggerId: 'issue-and-pippo-mail',
    version: '1',
    clauses: [
      {
        id: 'issue',
        event: 'github.issue.opened',
        where: [
          { path: 'repository', op: 'eq', value: 'acme/app' },
        ],
      },
      {
        id: 'mail',
        event: 'email.received',
        where: [
          { path: 'from', op: 'eq', value: 'pippo@example.com' },
        ],
      },
    ],
    expression: {
      kind: 'allOf',
      refs: ['issue', 'mail'],
    },
    withinMs: 24 * 60 * 60 * 1000,
    correlation: {
      semantic: {
        instruction: 'The email concerns the GitHub issue.',
        input: ['issue.title', 'mail.subject', 'mail.bodyPreview'],
        matchThreshold: 0.8,
        rejectThreshold: 0.2,
        uncertain: 'escalate',
      },
    },
    target: {
      runtime: 'runtime-probe',
      kind: 'task',
      id: 'issue-report',
    },
  };
}

test('composite trigger fixture validates', async () => {
  const raw = JSON.parse(
    await readFile(
      'conformance/fixtures/composite-trigger.valid.json',
      'utf8',
    ),
  );

  const parsed = CompositeTriggerDefinitionSchema.parse(raw);
  assert.equal(parsed.triggerId, 'issue-and-pippo-mail');
  assert.equal(parsed.expression.kind, 'allOf');
});

test('issue + related Pippo email matches once and replay cannot refire', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-ei-trigger-'));

  try {
    const evaluator = {
      async evaluate(request) {
        const subject = String(request.input['mail.subject'] ?? '').toLowerCase();
        return {
          evaluator: 'test/relation',
          probability: subject.includes('signup') ? 0.97 : 0.05,
          metadata: { resolvedModel: 'relation-test-v1' },
        };
      },
    };

    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store, evaluator);
    await engine.register(issueMailTrigger());

    const issueResult = await engine.ingest(
      event({
        id: 'github_delivery_1',
        name: 'github.issue.opened',
        at: '2026-09-18T08:00:00.000Z',
        provider: 'github',
        data: {
          repository: 'acme/app',
          number: 42,
          title: 'Signup fails after email verification',
        },
      }),
    );

    assert.equal(issueResult.length, 1);
    assert.equal(issueResult[0].match.status, 'partial');

    const unrelatedSender = await engine.ingest(
      event({
        id: 'mail_alice_1',
        name: 'email.received',
        at: '2026-09-18T09:00:00.000Z',
        provider: 'gmail',
        data: {
          from: 'alice@example.com',
          subject: 'Signup issue',
          bodyPreview: 'About issue 42',
        },
      }),
    );
    assert.equal(unrelatedSender.length, 0);

    const unrelatedPippo = await engine.ingest(
      event({
        id: 'mail_pippo_1',
        name: 'email.received',
        at: '2026-09-18T09:10:00.000Z',
        provider: 'gmail',
        data: {
          from: 'pippo@example.com',
          subject: 'Quarterly lunch',
          bodyPreview: 'Are you free tomorrow?',
        },
      }),
    );

    assert.equal(unrelatedPippo[0].matched, false);
    assert.equal(
      unrelatedPippo[0].match.correlationDecision.outcome,
      'reject',
    );
    assert.equal(unrelatedPippo[0].match.status, 'partial');

    const relatedMail = event({
      id: 'mail_pippo_2',
      name: 'email.received',
      at: '2026-09-18T09:20:00.000Z',
      provider: 'gmail',
      data: {
        from: 'pippo@example.com',
        subject: 'Signup problem in issue 42',
        bodyPreview: 'The verification step is the same failure in the GitHub issue.',
      },
    });

    const matched = await engine.ingest(relatedMail);
    assert.equal(matched[0].matched, true);
    assert.equal(matched[0].match.status, 'matched');
    assert.equal(matched[0].match.sourceEvents.length, 3);
    assert.equal(matched[0].match.correlationDecision.probability, 0.97);

    const fired = await engine.markFired(
      matched[0].match.matchId,
      'wake_composite_1',
    );
    assert.equal(fired.status, 'fired');
    assert.equal(fired.firedWakeId, 'wake_composite_1');

    const replay = await engine.ingest(relatedMail);
    assert.equal(replay[0].fired, true);
    assert.equal(replay[0].match.matchId, fired.matchId);

    assert.equal(store.listTriggerMatches().length, 1);
    assert.equal(
      store.listTriggerMatchHistory(fired.matchId).at(-1).status,
      'fired',
    );
    assert.equal(await store.verifyAudit(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('partial composite state survives restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-ei-trigger-restart-'));

  try {
    const evaluator = {
      async evaluate() {
        return { evaluator: 'test/relation', probability: 0.95 };
      },
    };

    const firstStore = new PersistentEventStore(dir);
    await firstStore.init();
    const firstEngine = new CompositeTriggerEngine(firstStore, evaluator);
    await firstEngine.register(issueMailTrigger());

    await firstEngine.ingest(
      event({
        id: 'github_restart_1',
        name: 'github.issue.opened',
        at: '2026-09-18T08:00:00.000Z',
        data: {
          repository: 'acme/app',
          title: 'Signup broken',
        },
      }),
    );

    assert.equal(firstStore.listTriggerMatches()[0].status, 'partial');

    const secondStore = new PersistentEventStore(dir);
    const restored = await secondStore.init();
    assert.equal(restored.triggers, 1);
    assert.equal(restored.triggerMatches, 1);

    const secondEngine = new CompositeTriggerEngine(secondStore, evaluator);
    const result = await secondEngine.ingest(
      event({
        id: 'mail_restart_1',
        name: 'email.received',
        at: '2026-09-18T10:00:00.000Z',
        data: {
          from: 'pippo@example.com',
          subject: 'Signup broken',
          bodyPreview: 'Same problem.',
        },
      }),
    );

    assert.equal(result[0].matched, true);
    assert.equal(result[0].match.status, 'matched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sequence waits for a valid later event and count fires at threshold', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-ei-trigger-expr-'));

  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);

    await engine.register({
      protocolVersion: '0.1.0',
      schemaVersion: 'trigger.v0.1',
      triggerId: 'issue-then-comment',
      version: '1',
      clauses: [
        { id: 'opened', event: 'github.issue.opened', where: [] },
        { id: 'comment', event: 'github.issue.commented', where: [] },
      ],
      expression: {
        kind: 'sequence',
        refs: ['opened', 'comment'],
      },
      withinMs: 60 * 60 * 1000,
      target: {
        runtime: 'runtime-probe',
        kind: 'task',
        id: 'sequence-test',
      },
    });

    await engine.register({
      protocolVersion: '0.1.0',
      schemaVersion: 'trigger.v0.1',
      triggerId: 'three-comments',
      version: '1',
      clauses: [
        { id: 'comment', event: 'github.issue.commented', where: [] },
      ],
      expression: {
        kind: 'count',
        ref: 'comment',
        atLeast: 3,
      },
      withinMs: 60 * 60 * 1000,
      target: {
        runtime: 'runtime-probe',
        kind: 'task',
        id: 'count-test',
      },
    });

    const earlyComment = event({
      id: 'comment_early',
      name: 'github.issue.commented',
      at: '2026-09-18T08:00:00.000Z',
      data: {},
    });
    await engine.ingest(earlyComment);

    const opened = await engine.ingest(
      event({
        id: 'opened_1',
        name: 'github.issue.opened',
        at: '2026-09-18T08:05:00.000Z',
        data: {},
      }),
    );
    const sequenceAfterOpen = opened.find(
      (item) => item.triggerId === 'issue-then-comment',
    );
    assert.equal(sequenceAfterOpen.matched, false);

    const laterCommentResults = await engine.ingest(
      event({
        id: 'comment_later',
        name: 'github.issue.commented',
        at: '2026-09-18T08:10:00.000Z',
        data: {},
      }),
    );
    const sequenceMatched = laterCommentResults.find(
      (item) => item.triggerId === 'issue-then-comment',
    );
    assert.equal(sequenceMatched.matched, true);

    await engine.ingest(
      event({
        id: 'count_2',
        name: 'github.issue.commented',
        at: '2026-09-18T08:20:00.000Z',
        data: {},
      }),
    );
    const countThird = await engine.ingest(
      event({
        id: 'count_3',
        name: 'github.issue.commented',
        at: '2026-09-18T08:30:00.000Z',
        data: {},
      }),
    );

    const countMatched = countThird.find(
      (item) => item.triggerId === 'three-comments',
    );
    assert.equal(countMatched.matched, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('same event id from different MCP servers is not treated as replay', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-ei-server-scope-'));

  try {
    const store = new PersistentEventStore(dir);
    await store.init();
    const engine = new CompositeTriggerEngine(store);

    await engine.register({
      protocolVersion: '0.1.0',
      schemaVersion: 'trigger.v0.1',
      triggerId: 'cross-server-same-id',
      version: '1',
      clauses: [
        { id: 'a', event: 'provider.a', where: [] },
        { id: 'b', event: 'provider.b', where: [] },
      ],
      expression: { kind: 'allOf', refs: ['a', 'b'] },
      withinMs: 60 * 60 * 1000,
      target: { runtime: 'runtime-probe', kind: 'task', id: 'test' },
    });

    const first = await engine.ingest(event({
      id: 'same-id',
      name: 'provider.a',
      at: '2026-09-18T08:00:00.000Z',
      serverId: 'server-a',
      data: {},
    }));
    assert.equal(first[0].matched, false);

    const second = await engine.ingest(event({
      id: 'same-id',
      name: 'provider.b',
      at: '2026-09-18T08:01:00.000Z',
      serverId: 'server-b',
      data: {},
    }));
    assert.equal(second[0].matched, true);
    assert.equal(second[0].match.sourceEvents.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
