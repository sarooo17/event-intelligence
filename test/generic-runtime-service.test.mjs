import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalWakeJson } from '../scripts/lib/wake-signature.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('real service delivers one GitHub open+close composite wake to a generic runtime', { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ei-generic-service-'));
  const secret = 's'.repeat(32);
  let deliveries = 0;
  const receiver = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const packet = JSON.parse(Buffer.concat(chunks).toString());
    const timestamp = request.headers['x-event-wake-timestamp'];
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}.${canonicalWakeJson(packet)}`).digest('hex');
    assert.equal(request.headers['x-event-wake-signature'], `v1=${signature}`);
    assert.equal(packet.target.runtime, 'mini-agent');
    assert.deepEqual(packet.source_event_refs.map((ref) => ref.event_name), [
      'github.issue.opened', 'github.issue.closed',
    ]);
    deliveries++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      runtimeReceiptId: `mini-agent:${packet.wake_id}`,
    }));
  });

  const receiverPort = await listen(receiver);
  const servicePort = await freePort();
  const child = spawn(process.execPath, ['scripts/service.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(servicePort),
      DATA_DIR: dir,
      SERVICE_AUTH_TOKEN: 'test-token',
      RUNTIME_WAKE_TARGETS_JSON: JSON.stringify({
        'mini-agent': {
          url: `http://127.0.0.1:${receiverPort}/wake`,
          secret,
        },
      }),
      TYPESAFE_API_KEY: '',
      SEMANTIC_INSTRUCTION: '',
    },
    stdio: 'ignore',
  });

  t.after(async () => {
    child.kill();
    await new Promise((resolve) => receiver.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${servicePort}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      ready = (await fetch(`${base}/healthz`)).ok;
      if (ready) break;
    } catch {
      // startup
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true);

  const request = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.ok, true, JSON.stringify(result));
    return result;
  };

  await request('POST', '/v1/triggers', {
    protocolVersion: '0.1.0',
    schemaVersion: 'trigger.v0.1',
    triggerId: 'generic-live-shape',
    version: '1',
    clauses: [
      { id: 'opened', event: 'github.issue.opened', serverId: 'github-mcp-events', where: [] },
      { id: 'closed', event: 'github.issue.closed', serverId: 'github-mcp-events', where: [] },
    ],
    expression: { kind: 'allOf', refs: ['opened', 'closed'] },
    withinMs: 3600_000,
    correlation: {
      deterministic: {
        kind: 'same_value',
        fields: [
          { ref: 'opened', path: 'number' },
          { ref: 'closed', path: 'number' },
        ],
      },
    },
    target: { runtime: 'mini-agent', kind: 'task', id: 'issue-report' },
  });

  const at = new Date().toISOString();
  const opened = {
    traceId: 'trace_open',
    sourceEventId: 'gh_open_1',
    name: 'github.issue.opened',
    serverId: 'github-mcp-events',
    provider: 'github',
    occurredAt: at,
    data: { repository: 'example/test', number: 42, title: 'FC-014 proof' },
  };
  const closed = {
    traceId: 'trace_close',
    sourceEventId: 'gh_close_1',
    name: 'github.issue.closed',
    serverId: 'github-mcp-events',
    provider: 'github',
    occurredAt: at,
    data: { repository: 'example/test', number: 42, title: 'FC-014 proof' },
  };

  const partial = await request('POST', '/v1/composite/events/ingest', opened);
  assert.equal(partial.results[0].match.status, 'partial');
  assert.equal(partial.deliveries.length, 0);

  const completed = await request('POST', '/v1/composite/events/ingest', closed);
  assert.equal(completed.results[0].matched, true);
  assert.equal(completed.deliveries[0].status, 'handled');
  assert.match(completed.deliveries[0].runtimeReceiptId, /^mini-agent:/);
  assert.equal(deliveries, 1);

  await request('POST', '/v1/composite/events/ingest', closed);
  assert.equal(deliveries, 1);
});
