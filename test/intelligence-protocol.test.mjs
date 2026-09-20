import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AuditChain,
  EventLineageSchema,
  assertDecisionLineage,
  assertTransition,
  assertWakeLineage,
  mapMcpEventToLineage,
} from '../dist/src/intelligenceProtocol/index.js';

test('conformance fixture validates against protocol v0.1 schema', async () => {
  const fixture = JSON.parse(
    await readFile('conformance/fixtures/event-lineage.valid.json', 'utf8'),
  );
  const parsed = EventLineageSchema.parse(fixture);

  assert.equal(parsed.protocolVersion, '0.1.0');
  assert.equal(parsed.schemaVersion, 'ei.v0.1');
});

test('MCP event maps to stable auditable lineage with payload hash', async () => {
  const lineage = await mapMcpEventToLineage({
    event: {
      eventId: 'evt_protocol',
      name: 'github.issue.opened',
      timestamp: '2026-09-18T06:29:59.000Z',
      cursor: null,
      data: {
        repository: 'acme/app',
        number: 55,
        title: 'Signup is blocked',
        labels: ['onboarding'],
      },
    },
    traceId: 'trace_protocol',
    environmentId: 'env_ci',
    subscriptionId: 'sub_protocol',
    serverId: 'reference-mcp',
    transport: 'poll',
    target: {
      runtime: 'runtime-probe',
      kind: 'task',
      id: 'session_protocol',
    },
    observedAt: '2026-09-18T06:30:00.000Z',
  });

  assert.equal(lineage.sourceEventId, 'evt_protocol');
  assert.match(lineage.event.payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(lineage.target.id, 'session_protocol');
});

test('invalid lifecycle transitions are rejected', () => {
  assert.doesNotThrow(() => assertTransition('received', 'evaluating'));
  assert.doesNotThrow(() => assertTransition('matched', 'wake_queued'));

  assert.throws(
    () => assertTransition('handled', 'wake_queued'),
    /Invalid event-intelligence lifecycle transition/,
  );
  assert.throws(
    () => assertTransition('rejected', 'matched'),
    /Invalid event-intelligence lifecycle transition/,
  );
});

test('decision and wake lineage cannot detach from the source event', () => {
  const event = EventLineageSchema.parse({
    protocol: 'mcp-event-intelligence',
    protocolVersion: '0.1.0',
    schemaVersion: 'ei.v0.1',
    traceId: 'trace_1',
    environmentId: 'env_ci',
    subscriptionId: 'sub_1',
    sourceEventId: 'evt_1',
    observedAt: '2026-09-18T06:30:00.000Z',
    source: {
      serverId: 'server_1',
      transport: 'internal',
      cursor: null,
    },
    target: {
      runtime: 'runtime-probe',
      kind: 'task',
      id: 'session_1',
    },
    event: {
      name: 'issue.opened',
      occurredAt: '2026-09-18T06:29:59.000Z',
      payloadHash: 'b'.repeat(64),
    },
  });

  const decision = {
    decisionId: 'decision_1',
    traceId: 'trace_1',
    subscriptionId: 'sub_1',
    sourceEventId: 'evt_1',
    createdAt: '2026-09-18T06:30:01.000Z',
    evaluator: 'test/evaluator',
    outcome: 'match',
    probability: 0.95,
    matched: true,
    shouldEscalate: false,
    policy: {
      matchThreshold: 0.8,
      rejectThreshold: 0.2,
      uncertain: 'escalate',
    },
    inputFields: ['data.title'],
  };

  const wake = {
    wakeId: 'wake_1',
    traceId: 'trace_1',
    decisionId: 'decision_1',
    subscriptionId: 'sub_1',
    sourceEventId: 'evt_1',
    createdAt: '2026-09-18T06:30:02.000Z',
    target: event.target,
    status: 'queued',
  };

  assert.doesNotThrow(() => assertDecisionLineage(event, decision));
  assert.doesNotThrow(() => assertWakeLineage(event, decision, wake));

  assert.throws(
    () => assertWakeLineage(event, decision, {
      ...wake,
      sourceEventId: 'evt_other',
    }),
    /sourceEventId/,
  );
});

test('audit chain is ordered, linked and tamper-evident', async () => {
  const audit = new AuditChain();

  await audit.append({
    auditId: 'audit_1',
    traceId: 'trace_audit',
    timestamp: '2026-09-18T06:30:00.000Z',
    kind: 'event.received',
    entityType: 'event',
    entityId: 'evt_audit',
    toState: 'received',
  });

  await audit.append({
    auditId: 'audit_2',
    traceId: 'trace_audit',
    timestamp: '2026-09-18T06:30:01.000Z',
    kind: 'lifecycle.transition',
    entityType: 'event',
    entityId: 'evt_audit',
    fromState: 'received',
    toState: 'evaluating',
  });

  assert.equal(await audit.verify(), true);

  const records = audit.list();
  assert.equal(records[1].previousHash, records[0].hash);
  assert.equal(records[0].sequence, 0);
  assert.equal(records[1].sequence, 1);
});
