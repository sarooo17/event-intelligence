#!/usr/bin/env node
// Runnable outside the EI checkout after installing the packed package.
// The fixture source is synthetic: this proves exported authoring/planning,
// NOT a live provider connection or permission to create a durable trigger.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { toTriggerPlan } from 'mcp-event-intelligence/embedded';
import { createEventIntelligenceHost } from 'mcp-event-intelligence/host';

const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-packed-simple-example-'));
let ei;
try {
  ei = await createEventIntelligenceHost({
    dataDir: dir,
    env: {
      TYPESAFE_API_KEY: '',
      RUNTIME_WAKE_TARGETS_JSON: '{}',
      TEMPORAL_TICK_MS: '100000',
      WAKE_RETRY_TICK_MS: '100000',
    },
  });

  // An actual host must expose sources from its existing MCP connection
  // registry. Only this self-contained test inserts a synthetic descriptor.
  await ei.store.putEventSource({
    sourceId: 'test:issue.changed',
    connectionId: 'test-events-connection',
    serverId: 'test-events',
    eventName: 'test.issue.changed',
    delivery: ['poll'],
    inputSchema: { type: 'object', additionalProperties: false },
    payloadSchema: {
      type: 'object',
      properties: { severity: { type: 'number' } },
    },
  });

  const input = toTriggerPlan({
    when: {
      event: 'test.issue.changed',
      serverId: 'test-events',
      where: [{ path: 'severity', op: 'gte', value: 3 }],
    },
    then: {
      target: { runtime: 'demo-host', kind: 'task', id: 'triage' },
      instruction: 'Review a high-severity issue.',
    },
    lifecycle: { oneShot: true },
  });

  const planned = await ei.planTrigger(input);
  assert.equal(planned.planVersion, '2');
  assert.equal(planned.definition.clauses.length, 1);
  assert.equal(planned.definition.clauses[0].where[0].path, 'severity');
  assert.deepEqual(planned.connectionIds, ['test-events-connection']);
  assert.equal(planned.definition.pattern.version, '2');
  assert.equal(planned.definition.target.runtime, 'demo-host');

  // No durable mutation, host approval, provider call or agent loop occurs.
  assert.deepEqual(await ei.store.listTriggers(), []);
  console.log(JSON.stringify({
    schema: 'event-intelligence.packed-simple-example.v1',
    status: 'pass',
    source: planned.connectionIds[0],
    canonicalPattern: planned.definition.pattern.version,
    mutations: 0,
  }));
} finally {
  try { await ei?.close(); } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
