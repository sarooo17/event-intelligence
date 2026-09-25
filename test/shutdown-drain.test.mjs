import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEventIntelligenceHost } from '../scripts/host-integration.mjs';

test('host close drains an in-flight MCP poll before persistent store cleanup', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ei-shutdown-drain-'));
  let pollEntered;
  let releasePoll;
  const entered = new Promise((resolve) => { pollEntered = resolve; });
  const gate = new Promise((resolve) => { releasePoll = resolve; });

  const client = {
    getServerCapabilities() {
      return {
        extensions: {
          'io.modelcontextprotocol/events': {
            listChanged: false,
          },
        },
      };
    },
    async request(message) {
      if (message.method === 'events/list') {
        return {
          events: [{
            name: 'shutdown.event',
            delivery: ['poll'],
            payloadSchema: {
              type: 'object',
              required: ['value'],
              properties: { value: { type: 'string' } },
            },
          }],
        };
      }
      if (message.method === 'events/poll') {
        pollEntered();
        await gate;
        return {
          events: [{
            eventId: 'shutdown-event-1',
            name: 'shutdown.event',
            timestamp: '2026-09-20T16:00:00.000Z',
            data: { value: 'ok' },
          }],
          cursor: 'done',
          hasMore: false,
        };
      }
      throw new Error(`Unexpected method ${message.method}`);
    },
  };

  const host = await createEventIntelligenceHost({
    dataDir,
    env: {
      TYPESAFE_API_KEY: '',
      RUNTIME_WAKE_TARGETS_JSON: '{}',
      TEMPORAL_TICK_MS: '100000',
      WAKE_RETRY_TICK_MS: '100000',
    },
    mcpClients: [{
      connectionId: 'shutdown-connection',
      serverId: 'shutdown-server',
      client,
      pollIntervalMs: 300000,
    }],
  });

  try {
    const poll = host.runtime.mcpEventsClient.pollConnection('shutdown-connection');
    await entered;

    let closed = false;
    const closing = host.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false, 'close must wait for the active poll');

    releasePoll();
    await Promise.all([poll, closing]);

    await rm(dataDir, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 25));

    await assert.rejects(
      access(dataDir),
      (error) => error?.code === 'ENOENT',
      'no background store write may recreate the directory after close',
    );
  } finally {
    releasePoll?.();
    await host.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
