import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

async function connect({ writeEnabled = false } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-mcp-stdio-'));
  const client = new Client(
    { name: 'event-intelligence-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['bin/mcp-event-intelligence.mjs', 'mcp'],
    cwd: rootDir,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      MCP_WRITE_ENABLED: writeEnabled ? 'true' : 'false',
      MCP_OWNER_ID: 'test-user',
      MCP_ACTOR_ID: 'test-agent',
      RUNTIME_WAKE_TARGETS_JSON: '{}',
      TYPESAFE_API_KEY: '',
    },
    stderr: 'pipe',
  });

  await client.connect(transport);

  return {
    client,
    transport,
    dataDir,
    async close() {
      await client.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('MCP stdio adapter exposes read-only Event Intelligence tools by default', async () => {
  const session = await connect();
  try {
    const { tools } = await session.client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, [
      'derived_contracts_list',
      'event_sources_list',
      'runtime_status',
      'trigger_inspect',
      'trigger_list',
      'trigger_plan',
      'trigger_simulate',
      'wake_hydrate',
    ]);

    const status = await session.client.callTool({
      name: 'runtime_status',
      arguments: {},
    });
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.writeEnabled, false);

    const planWithoutSources = await session.client.callTool({
      name: 'trigger_plan',
      arguments: {
        events: [{ event: 'release.ready' }],
        target: { runtime: 'demo', kind: 'task', id: 'release-review' },
        continuation: { instruction: 'Review the release.' },
      },
    });
    assert.equal(planWithoutSources.isError, true);
    assert.match(
      planWithoutSources.content[0].text,
      /No active source exposes|SOURCE_NOT_FOUND/i,
    );

    const simulation = await session.client.callTool({
      name: 'trigger_simulate',
      arguments: {
        definition: {
          triggerId: 'mcp-sim',
          version: '1',
          clauses: [
            {
              id: 'ready',
              event: 'release.ready',
              serverId: 'example',
              where: [],
            },
          ],
          expression: { kind: 'anyOf', refs: ['ready'] },
          withinMs: 60000,
          target: {
            runtime: 'demo',
            kind: 'task',
            id: 'release-review',
          },
        },
        events: [
          {
            traceId: 'trace-1',
            sourceEventId: 'evt-1',
            name: 'release.ready',
            serverId: 'example',
            provider: 'test',
            occurredAt: '2026-09-19T08:00:00.000Z',
            data: {},
          },
        ],
        order: 'provided',
      },
    });

    assert.equal(simulation.isError, undefined);
    assert.equal(simulation.structuredContent.inspection.match.status, 'matched');
  } finally {
    await session.close();
  }
});

test('MCP stdio write tools require explicit operator opt-in', async () => {
  const session = await connect({ writeEnabled: true });
  try {
    const { tools } = await session.client.listTools();
    const names = new Set(tools.map((tool) => tool.name));

    for (const name of [
      'trigger_create',
      'trigger_pause',
      'trigger_resume',
      'trigger_update',
      'trigger_delete',
    ]) {
      assert.equal(names.has(name), true, `missing ${name}`);
    }

    const result = await session.client.callTool({
      name: 'trigger_create',
      arguments: {
        definition: {
          triggerId: 'cannot-bypass-source-scope',
          version: '1',
          clauses: [
            {
              id: 'ghost',
              event: 'ghost.event',
              serverId: 'ghost',
              where: [],
            },
          ],
          expression: { kind: 'anyOf', refs: ['ghost'] },
          withinMs: 60000,
          target: {
            runtime: 'demo',
            kind: 'task',
            id: 'x',
          },
        },
        connectionIds: ['ghost'],
        confirmationId: 'confirmed-by-test',
      },
    });

    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /Event source unavailable|connection/i,
    );

    const plannedResult = await session.client.callTool({
      name: 'trigger_create',
      arguments: {
        plan: {
          events: [{ event: 'ghost.event', serverId: 'ghost' }],
          target: { runtime: 'demo', kind: 'task', id: 'x' },
          continuation: { instruction: 'Handle the ghost event.' },
        },
        confirmationId: 'confirmed-plan-by-test',
      },
    });
    assert.equal(plannedResult.isError, true);
    assert.match(
      plannedResult.content[0].text,
      /No active source exposes|SOURCE_NOT_FOUND/i,
    );
  } finally {
    await session.close();
  }
});
