import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { operationNamesForSurface } from '../scripts/lib/operation-manifest.mjs';
import * as z from 'zod/v4';
import { OPERATION_MANIFEST } from '../scripts/lib/operation-manifest.mjs';
import { MCP_OPERATION_SCHEMAS } from '../scripts/lib/mcp-operation-schemas.mjs';
import { outputJsonSchema } from '../scripts/lib/operation-output-contracts.mjs';

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

function assertMcpWireSchemaParity(tools) {
  const entries = Object.entries(OPERATION_MANIFEST);
  for (const tool of tools) {
    const pair = entries.find(([, entry]) => entry.name === tool.name);
    assert.ok(pair, 'missing operation metadata for ' + tool.name);
    const [key] = pair;
    // Compare full nested JSON schemas, including enum values, bounds,
    // defaults and additionalProperties—not just top-level property names.
    // input mode matches the schema seen by a model/tool caller.
    const expected = z.toJSONSchema(MCP_OPERATION_SCHEMAS[key], {
      io: 'input',
    });
    assert.deepEqual(
      tool.inputSchema.properties ?? {},
      expected.properties ?? {},
      'MCP wire nested input schema drifted for ' + key,
    );
    assert.equal(
      tool.inputSchema.additionalProperties,
      expected.additionalProperties,
      'MCP wire additionalProperties drifted for ' + key,
    );
    // MCP's SDK treats Zod defaults as optional at the wire boundary.
    // A direct z.toJSONSchema() marks defaulted fields as required in its
    // output projection; derive actual input requiredness from the same
    // underlying Zod shape instead of treating that SDK difference as drift.
    const requiredByValidator = Object.entries(MCP_OPERATION_SCHEMAS[key].shape)
      .filter(([, field]) => !field.isOptional())
      .map(([name]) => name).sort();
    assert.deepEqual(
      [...(tool.inputSchema.required ?? [])].sort(),
      requiredByValidator,
      'MCP wire required fields drifted for ' + key,
    );
  }
}

test('MCP stdio adapter exposes read-only Event Intelligence tools by default', async () => {
  const session = await connect();
  try {
    const { tools } = await session.client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assertMcpWireSchemaParity(tools);
    for (const key of ['sources','list','plan']) {
      const op=OPERATION_MANIFEST[key];
      const wire=tools.find(tool=>tool.name===op.name)?.outputSchema;
      assert.ok(wire,'missing MCP outputSchema for '+key);
      const expected=outputJsonSchema('stdio',key);
      assert.deepEqual(wire.properties,expected.properties,key);
      assert.deepEqual(wire.required,expected.required,key);
    }
    for (const key of ['update','wakeHydrate','inspect']) {
      const op=OPERATION_MANIFEST[key];
      const wire=tools.find(tool=>tool.name===op.name)?.outputSchema;
      if (wire) throw new Error('Unmodeled output contract falsely advertised: '+key);
    }

    assert.deepEqual(
      names,
      operationNamesForSurface('stdio', { allowMutations: false }).sort(),
    );

    assert.deepEqual(names, [
      'derived_contracts_list',
      'event_sources_list',
      'runtime_status',
      'trigger_inspect',
      'trigger_language_describe',
      'trigger_list',
      'trigger_plan',
      'trigger_simulate',
      'wake_hydrate',
    ]);

    const triggerPlanTool = tools.find((tool) => tool.name === 'trigger_plan');
    assert.ok(triggerPlanTool);
    const triggerPlanSchema = JSON.stringify(triggerPlanTool.inputSchema);
    for (const operator of [
      'calendar',
      'absence',
      'notPresent',
      'notNext',
      'notFollowedBy',
      'after',
      'until',
      'debounce',
      'threshold',
      'rate',
      'distinct',
      'window',
      'compare',
      'aggregate',
      'state',
      'semantic',
    ]) {
      assert.match(
        triggerPlanSchema,
        new RegExp(`"${operator}"`),
        `trigger_plan schema does not advertise Pattern operator ${operator}`,
      );
    }

    // Owner cannot be overridden through a model-supplied argument.
    const triggerList = tools.find((tool) => tool.name === 'trigger_list');
    assert.ok(triggerList);
    assert.equal(
      Object.hasOwn(triggerList.inputSchema.properties ?? {}, 'ownerOnly'),
      false,
    );
    assert.deepEqual(
      (await session.client.callTool({
        name: 'trigger_list',
        arguments: {},
      })).structuredContent.triggers,
      [],
    );
    for (const [name, args] of [
      ['trigger_inspect', { triggerId: 'someone-elses-trigger' }],
      ['wake_hydrate', { wakeId: 'someone-elses-wake' }],
    ]) {
      const forbidden = await session.client.callTool({
        name, arguments: args,
      });
      assert.equal(forbidden.isError, true);
      assert.equal(
        forbidden.structuredContent.code,
        'EVENT_INTELLIGENCE_RESOURCE_NOT_FOUND',
      );
      assert.doesNotMatch(
        JSON.stringify(forbidden),
        /someone-elses-(trigger|wake)/,
      );
    }

    const status = await session.client.callTool({
      name: 'runtime_status',
      arguments: {},
    });
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.writeEnabled, false);

    const language = await session.client.callTool({
      name: 'trigger_language_describe',
      arguments: { category: 'pattern' },
    });
    assert.equal(language.isError, undefined);
    assert.equal(language.structuredContent.version, '3');
    assert.ok(language.structuredContent.pattern.length >= 10);
    assert.equal(
      language.structuredContent.pattern.some(
        (entry) => entry.id === 'absence',
      ),
      true,
    );

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
          pattern: { root: { kind: 'event', ref: 'ready' } },
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
    assertMcpWireSchemaParity(tools);
    assert.deepEqual(
      [...names].sort(),
      operationNamesForSurface('stdio').sort(),
    );

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
          pattern: { root: { kind: 'event', ref: 'ghost' } },
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
