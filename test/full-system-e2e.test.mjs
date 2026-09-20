import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalWakeJson } from '../scripts/lib/wake-signature.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const actor = { type: 'user', principal_id: 'e2e-user' };
const authToken = 'e2e-service-token';
const runtimeSecret =
  'e2e-runtime-secret-0123456789-abcdefghijklmnopqrstuvwxyz';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startRuntimeReceiver() {
  const packets = [];
  const receipts = new Map();

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const packet = JSON.parse(raw);

    const timestamp = String(request.headers['x-event-wake-timestamp'] || '');
    const supplied = String(
      request.headers['x-event-wake-signature'] || '',
    ).replace(/^v1=/, '');
    const expected = createHmac('sha256', runtimeSecret)
      .update(`${timestamp}.${canonicalWakeJson(packet)}`)
      .digest('hex');

    const valid =
      supplied.length === expected.length &&
      timingSafeEqual(
        Buffer.from(supplied, 'utf8'),
        Buffer.from(expected, 'utf8'),
      );

    if (!valid) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'bad_signature' }));
      return;
    }

    const duplicate = receipts.has(packet.wake_id);
    const runtimeReceiptId =
      receipts.get(packet.wake_id) ?? `receipt:${packet.wake_id}`;
    receipts.set(packet.wake_id, runtimeReceiptId);
    packets.push({
      packet,
      timestamp,
      signatureValid: valid,
      duplicate,
      runtimeReceiptId,
    });

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      runtimeReceiptId,
      duplicate,
      status: 'completed',
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}/wake`,
    packets,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    }),
  };
}

async function waitFor(predicate, {
  timeoutMs = 8000,
  intervalMs = 50,
  description = 'condition',
} = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}; last=${JSON.stringify(last)}`);
}

async function startService({
  port,
  dataDir,
  runtimeUrl,
}) {
  const stdout = [];
  const stderr = [];
  const child = spawn(
    process.execPath,
    ['scripts/service.mjs'],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        ENVIRONMENT_ID: 'black-box-e2e',
        SERVICE_AUTH_TOKEN: authToken,
        TEMPORAL_TICK_MS: '50',
        MAX_DERIVED_EVENT_DEPTH: '16',
        RUNTIME_WAKE_TARGETS_JSON: JSON.stringify({
          'runtime-e2e': {
            url: runtimeUrl,
            secret: runtimeSecret,
          },
        }),
        TYPESAFE_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  try {
    await waitFor(async () => {
      if (child.exitCode !== null) {
        throw new Error(
          `service exited early: stdout=${stdout.join('')} stderr=${stderr.join('')}`,
        );
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`);
        return response.ok ? response.json() : false;
      } catch {
        return false;
      }
    }, {
      description: 'service readiness',
    });
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGKILL');
    throw new Error(
      `${error.message}; service stdout=${stdout.join('')} stderr=${stderr.join('')}`,
      { cause: error },
    );
  }

  return {
    child,
    stdout,
    stderr,
    async stop() {
      const hasExited = () =>
        child.exitCode !== null || child.signalCode !== null;

      if (hasExited()) return;

      const waitForExit = () =>
        new Promise((resolve) => {
          if (hasExited()) {
            resolve();
            return;
          }
          child.once('exit', resolve);
        });

      child.kill('SIGTERM');
      await Promise.race([
        waitForExit(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);

      if (!hasExited()) {
        const exited = waitForExit();
        child.kill('SIGKILL');
        await Promise.race([
          exited,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('service did not exit after SIGKILL')),
              2000,
            ),
          ),
        ]);
      }
    },
  };
}

async function api(port, pathname, {
  method = 'GET',
  body,
  expectedStatus,
} = {}) {
  const response = await fetch(
    `http://127.0.0.1:${port}${pathname}`,
    {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${authToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const payload = await response.json();

  if (expectedStatus !== undefined) {
    assert.equal(
      response.status,
      expectedStatus,
      `${method} ${pathname}: ${JSON.stringify(payload)}`,
    );
  } else {
    assert.ok(
      response.ok,
      `${method} ${pathname}: HTTP ${response.status} ${JSON.stringify(payload)}`,
    );
  }

  return { status: response.status, body: payload };
}

async function registerSource(port, source) {
  return api(port, '/v1/event-sources', {
    method: 'POST',
    expectedStatus: 201,
    body: { source, actor },
  });
}

async function createTrigger(port, definition, connectionIds) {
  return api(port, '/v1/control/triggers', {
    method: 'POST',
    expectedStatus: 201,
    body: {
      definition,
      connectionIds,
      actor,
      owner: actor,
    },
  });
}

async function ingest(port, event) {
  return api(port, '/v1/composite/events/ingest', {
    method: 'POST',
    expectedStatus: 202,
    body: event,
  });
}

function source({
  sourceId,
  connectionId,
  eventName,
  properties,
}) {
  return {
    sourceId,
    connectionId,
    serverId: connectionId,
    eventName,
    delivery: ['internal'],
    enabled: true,
    payloadSchema: {
      type: 'object',
      properties,
    },
  };
}

function event({
  id,
  name,
  serverId,
  data,
  at = new Date().toISOString(),
}) {
  return {
    traceId: `trace:${id}`,
    sourceEventId: id,
    name,
    serverId,
    provider: 'e2e',
    occurredAt: at,
    data,
  };
}

test('full-system black-box acceptance after FC-021', {
  timeout: 45000,
}, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-full-e2e-'));
  const runtime = await startRuntimeReceiver();
  const port = await freePort();
  let service = null;

  try {
    service = await startService({
      port,
      dataDir,
      runtimeUrl: runtime.url,
    });

    // ---- Scenario A: provider-neutral events -> contracts -> composition -> wake.
    await registerSource(port, source({
      sourceId: 'src_pr',
      connectionId: 'github',
      eventName: 'pr.merged',
      properties: {
        repository: { type: 'string' },
        number: { type: 'integer' },
      },
    }));
    await registerSource(port, source({
      sourceId: 'src_deploy',
      connectionId: 'railway',
      eventName: 'deploy.succeeded',
      properties: {
        repository: { type: 'string' },
        environment: { type: 'string' },
      },
    }));
    await registerSource(port, source({
      sourceId: 'src_approval',
      connectionId: 'approval',
      eventName: 'manager.approved',
      properties: {
        release: { type: 'string' },
      },
    }));

    await createTrigger(port, {
      triggerId: 'e2e-release-ready',
      version: '1',
      clauses: [
        { id: 'pr', event: 'pr.merged', serverId: 'github', where: [] },
        {
          id: 'deploy',
          event: 'deploy.succeeded',
          serverId: 'railway',
          where: [],
        },
      ],
      expression: { kind: 'allOf', refs: ['pr', 'deploy'] },
      withinMs: 60000,
      derivedEvent: {
        name: 'release.ready',
        contractVersion: '1',
        projections: [
          { key: 'repository', ref: 'pr', path: 'repository' },
        ],
        constants: { readiness: 'stable' },
      },
    }, ['github', 'railway']);

    await createTrigger(port, {
      triggerId: 'e2e-rollout-allowed',
      version: '1',
      clauses: [
        {
          id: 'release',
          event: 'release.ready',
          serverId: 'event-intelligence:derived',
          contractVersion: '1',
          where: [{ path: 'readiness', op: 'eq', value: 'stable' }],
        },
        {
          id: 'approval',
          event: 'manager.approved',
          serverId: 'approval',
          where: [],
        },
      ],
      expression: { kind: 'allOf', refs: ['release', 'approval'] },
      withinMs: 60000,
      derivedEvent: {
        name: 'rollout.allowed',
        contractVersion: '1',
        projections: [
          { key: 'repository', ref: 'release', path: 'repository' },
        ],
        constants: { gate: 'approved' },
      },
    }, ['event-intelligence:derived', 'approval']);

    await createTrigger(port, {
      triggerId: 'e2e-final-runtime',
      version: '1',
      clauses: [{
        id: 'rollout',
        event: 'rollout.allowed',
        serverId: 'event-intelligence:derived',
        contractVersion: '1',
        where: [],
      }],
      expression: { kind: 'anyOf', refs: ['rollout'] },
      withinMs: 60000,
      lifecycle: { oneShot: true },
      target: {
        runtime: 'runtime-e2e',
        kind: 'task',
        id: 'production-rollout',
      },
    }, ['event-intelligence:derived']);

    await ingest(port, event({
      id: 'pr-218',
      name: 'pr.merged',
      serverId: 'github',
      data: {
        repository: 'acme/app',
        number: 218,
        secretBody: 'must-not-become-lineage-payload',
      },
    }));
    await ingest(port, event({
      id: 'deploy-218',
      name: 'deploy.succeeded',
      serverId: 'railway',
      data: {
        repository: 'acme/app',
        environment: 'production',
      },
    }));

    assert.equal(runtime.packets.length, 0, 'derived layers must not wake runtime');

    const releaseContracts = await api(
      port,
      '/v1/derived-contracts?eventName=release.ready',
    );
    assert.equal(releaseContracts.body.contracts.length, 1);
    assert.equal(
      releaseContracts.body.contracts[0].contractVersion,
      '1',
    );
    assert.match(
      releaseContracts.body.contracts[0].schemaFingerprint,
      /^[a-f0-9]{64}$/,
    );

    const releaseEvents = await api(
      port,
      '/v1/derived-events?name=release.ready',
    );
    assert.equal(releaseEvents.body.events.length, 1);
    assert.equal(
      releaseEvents.body.events[0].event.data._derived.contractVersion,
      '1',
    );

    await ingest(port, event({
      id: 'approval-218',
      name: 'manager.approved',
      serverId: 'approval',
      data: { release: '218' },
    }));

    await waitFor(
      () => runtime.packets.length === 1 && runtime.packets[0],
      { description: 'generic runtime wake' },
    );

    assert.equal(runtime.packets[0].signatureValid, true);
    assert.equal(runtime.packets[0].packet.target.runtime, 'runtime-e2e');
    assert.equal(runtime.packets[0].packet.target.id, 'production-rollout');
    assert.match(
      runtime.packets[0].runtimeReceiptId,
      /^receipt:wake_/,
    );

    const rolloutEvents = await api(
      port,
      '/v1/derived-events?name=rollout.allowed',
    );
    assert.equal(rolloutEvents.body.events.length, 1);
    assert.deepEqual(
      rolloutEvents.body.events[0].rootEvidence
        .map((ref) => ref.sourceEventId)
        .sort(),
      ['approval-218', 'deploy-218', 'pr-218'],
    );
    assert.equal(
      JSON.stringify(rolloutEvents.body.events[0].rootEvidence)
        .includes('secretBody'),
      false,
    );

    const finalInspector = await api(
      port,
      '/v1/inspector/triggers/e2e-final-runtime?version=1',
    );
    assert.equal(finalInspector.body.match.status, 'fired');
    assert.equal(finalInspector.body.lifecycle.status, 'completed');
    assert.equal(
      finalInspector.body.wake.runtimeReceiptId,
      runtime.packets[0].runtimeReceiptId,
    );
    assert.equal(
      finalInspector.body.clauses[0].contractVersion,
      '1',
    );

    const derivedCountBeforeReplay =
      (await api(port, '/v1/derived-events')).body.events.length;
    await ingest(port, event({
      id: 'approval-218',
      name: 'manager.approved',
      serverId: 'approval',
      data: { release: '218' },
    }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(runtime.packets.length, 1);
    assert.equal(
      (await api(port, '/v1/derived-events')).body.events.length,
      derivedCountBeforeReplay,
    );

    // ---- Scenario C: contract evolution and ambiguity.
    await registerSource(port, source({
      sourceId: 'src_pr_compatible',
      connectionId: 'github-compatible',
      eventName: 'pr.compatible',
      properties: {
        repository: { type: 'string' },
      },
    }));
    await createTrigger(port, {
      triggerId: 'e2e-release-ready-compatible',
      version: '1',
      clauses: [{
        id: 'pr',
        event: 'pr.compatible',
        serverId: 'github-compatible',
        where: [],
      }],
      expression: { kind: 'anyOf', refs: ['pr'] },
      withinMs: 60000,
      derivedEvent: {
        name: 'release.ready',
        contractVersion: '1',
        projections: [
          { key: 'repository', ref: 'pr', path: 'repository' },
        ],
        constants: { readiness: 'stable' },
      },
    }, ['github-compatible']);

    const joinedV1 = await api(
      port,
      '/v1/derived-contracts?eventName=release.ready',
    );
    assert.equal(joinedV1.body.contracts[0].producers.length, 2);

    await registerSource(port, source({
      sourceId: 'src_pr_conflict',
      connectionId: 'github-conflict',
      eventName: 'pr.conflict',
      properties: {
        repository: { type: 'string' },
      },
    }));
    const conflict = await api(port, '/v1/control/triggers', {
      method: 'POST',
      expectedStatus: 400,
      body: {
        definition: {
          triggerId: 'e2e-release-ready-conflict',
          version: '1',
          clauses: [{
            id: 'pr',
            event: 'pr.conflict',
            serverId: 'github-conflict',
            where: [],
          }],
          expression: { kind: 'anyOf', refs: ['pr'] },
          withinMs: 60000,
          derivedEvent: {
            name: 'release.ready',
            contractVersion: '1',
            projections: [
              { key: 'repository', ref: 'pr', path: 'repository' },
            ],
            constants: {
              readiness: 'stable',
              incompatibleField: true,
            },
          },
        },
        connectionIds: ['github-conflict'],
        actor,
        owner: actor,
      },
    });
    assert.match(conflict.body.error, /contract conflict/i);

    const triggerListAfterConflict = await api(
      port,
      '/v1/control/triggers?ownerType=user&ownerId=e2e-user',
    );
    assert.equal(
      triggerListAfterConflict.body.triggers.some(
        (entry) =>
          entry.definition.triggerId === 'e2e-release-ready-conflict',
      ),
      false,
    );

    await registerSource(port, source({
      sourceId: 'src_pr_v2',
      connectionId: 'github-v2',
      eventName: 'pr.v2',
      properties: {
        repository: { type: 'string' },
      },
    }));
    await createTrigger(port, {
      triggerId: 'e2e-release-ready-v2',
      version: '1',
      clauses: [{
        id: 'pr',
        event: 'pr.v2',
        serverId: 'github-v2',
        where: [],
      }],
      expression: { kind: 'anyOf', refs: ['pr'] },
      withinMs: 60000,
      derivedEvent: {
        name: 'release.ready',
        contractVersion: '2',
        projections: [
          { key: 'repository', ref: 'pr', path: 'repository' },
        ],
        constants: {
          readiness: 'stable',
          revision: 2,
        },
      },
    }, ['github-v2']);

    const versions = await api(
      port,
      '/v1/derived-contracts?eventName=release.ready',
    );
    assert.deepEqual(
      versions.body.contracts.map((contract) => contract.contractVersion),
      ['1', '2'],
    );

    const ambiguous = await api(port, '/v1/control/triggers', {
      method: 'POST',
      expectedStatus: 400,
      body: {
        definition: {
          triggerId: 'e2e-ambiguous-release-consumer',
          version: '1',
          clauses: [{
            id: 'release',
            event: 'release.ready',
            serverId: 'event-intelligence:derived',
            where: [],
          }],
          expression: { kind: 'anyOf', refs: ['release'] },
          withinMs: 60000,
          target: {
            runtime: 'runtime-e2e',
            kind: 'task',
            id: 'ambiguous',
          },
        },
        connectionIds: ['event-intelligence:derived'],
        actor,
        owner: actor,
      },
    });
    assert.match(ambiguous.body.error, /ambiguous/i);

    // ---- Scenario B/D: durable time, process restart, derived event -> wake.
    await registerSource(port, source({
      sourceId: 'src_mail',
      connectionId: 'mail',
      eventName: 'email.received',
      properties: {
        threadId: { type: 'string' },
      },
    }));
    await registerSource(port, source({
      sourceId: 'src_reply',
      connectionId: 'mail',
      eventName: 'email.replied',
      properties: {
        threadId: { type: 'string' },
      },
    }));

    await createTrigger(port, {
      triggerId: 'e2e-no-reply',
      version: '1',
      clauses: [
        {
          id: 'mail',
          event: 'email.received',
          serverId: 'mail',
          where: [],
        },
        {
          id: 'reply',
          event: 'email.replied',
          serverId: 'mail',
          where: [],
        },
      ],
      expression: { kind: 'anyOf', refs: ['mail'] },
      temporal: [{
        id: 'no-reply-for-1s',
        kind: 'absence',
        ref: 'reply',
        afterRef: 'mail',
        forMs: 1000,
      }],
      withinMs: 10000,
      lifecycle: { oneShot: true },
      derivedEvent: {
        name: 'reply.overdue',
        contractVersion: '1',
        projections: [
          { key: 'threadId', ref: 'mail', path: 'threadId' },
        ],
        constants: { overdue: true },
      },
    }, ['mail']);

    await createTrigger(port, {
      triggerId: 'e2e-overdue-runtime',
      version: '1',
      clauses: [{
        id: 'overdue',
        event: 'reply.overdue',
        serverId: 'event-intelligence:derived',
        contractVersion: '1',
        where: [{ path: 'overdue', op: 'eq', value: true }],
      }],
      expression: { kind: 'anyOf', refs: ['overdue'] },
      withinMs: 10000,
      lifecycle: { oneShot: true },
      target: {
        runtime: 'runtime-e2e',
        kind: 'task',
        id: 'follow-up-overdue',
      },
    }, ['event-intelligence:derived']);

    const mailAt = new Date().toISOString();
    const mailEvent = event({
      id: 'mail-thread-42',
      name: 'email.received',
      serverId: 'mail',
      at: mailAt,
      data: { threadId: 'thread-42' },
    });
    await ingest(port, mailEvent);

    const pendingDeadline = await waitFor(async () => {
      const response = await api(
        port,
        '/v1/temporal/deadlines?triggerId=e2e-no-reply&status=pending',
      );
      return response.body.deadlines[0] || false;
    }, { description: 'persisted absence deadline' });
    assert.equal(pendingDeadline.status, 'pending');

    const wakeCountBeforeRestart = runtime.packets.length;
    await service.stop();
    service = null;

    await new Promise((resolve) => setTimeout(resolve, 1200));

    service = await startService({
      port,
      dataDir,
      runtimeUrl: runtime.url,
    });

    const overdueWake = await waitFor(
      () => runtime.packets.find(
        (entry) => entry.packet.target.id === 'follow-up-overdue',
      ) || false,
      { description: 'wake recovered from expired persisted deadline' },
    );
    assert.equal(overdueWake.signatureValid, true);
    assert.equal(
      runtime.packets.length,
      wakeCountBeforeRestart + 1,
    );

    const overdueEvents = await api(
      port,
      '/v1/derived-events?name=reply.overdue',
    );
    assert.equal(overdueEvents.body.events.length, 1);
    assert.equal(
      overdueEvents.body.events[0].event.data.threadId,
      'thread-42',
    );
    assert.deepEqual(
      overdueEvents.body.events[0].rootEvidence.map(
        (ref) => ref.sourceEventId,
      ),
      ['mail-thread-42'],
    );

    const ready = await fetch(
      `http://127.0.0.1:${port}/readyz`,
      { signal: AbortSignal.timeout(5000) },
    ).then((response) => response.json());
    assert.ok(ready.derivedContracts >= 3);
    assert.ok(ready.derivedEvents >= 3);

    const deadlineAfterRestart = await api(
      port,
      '/v1/temporal/deadlines?triggerId=e2e-no-reply',
    );
    assert.equal(deadlineAfterRestart.body.deadlines[0].status, 'fired');

    const beforeRestartReplayWakeCount = runtime.packets.length;
    const beforeRestartReplayDerivedCount =
      (await api(port, '/v1/derived-events')).body.events.length;

    await ingest(port, mailEvent);
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(runtime.packets.length, beforeRestartReplayWakeCount);
    assert.equal(
      (await api(port, '/v1/derived-events')).body.events.length,
      beforeRestartReplayDerivedCount,
    );

    const audit = await api(port, '/v1/audit');
    assert.equal(audit.body.verified, true);
    assert.ok(
      audit.body.records.some(
        (record) => record.kind === 'derived_contract.created',
      ),
    );
    assert.ok(
      audit.body.records.some(
        (record) => record.kind === 'derived_contract.conflict',
      ),
    );
    assert.ok(
      audit.body.records.some(
        (record) => record.kind === 'derived_event.created',
      ),
    );
  } finally {
    if (service) await service.stop();
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
