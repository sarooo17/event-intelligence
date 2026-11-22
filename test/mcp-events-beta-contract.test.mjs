import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCP_EVENTS_CAPABILITY,
  MCP_EVENTS_CAPABILITY_KEY,
  createMcpEventsProvider,
} from '../dist/src/mcpEvents/provider.js';
import {
  ExperimentalMcpEventsServer,
} from '../dist/src/mcpEvents/server.js';
import {
  DEFAULT_MCP_EVENTS_COMPATIBILITY_PROFILE,
  getMcpEventsCompatibilityProfile,
  resolveMcpEventsCompatibilityProfile,
} from '../scripts/lib/mcp-events-compatibility.mjs';

// Snapshot reviewed 2026-11-22:
// https://github.com/modelcontextprotocol/ext-events/blob/main/specification/beta/events/events.mdx
// These are LOCAL boundary regressions, not upstream conformance-suite results.
const betaId = 'beta-extension-2026-11-22';
const extensionId = 'io.modelcontextprotocol/events';
const name = 'fixture.changed';
const descriptor = {
  name,
  description: 'A fixture event.',
  delivery: ['poll'],
  inputSchema: { type: 'object', additionalProperties: false },
  payloadSchema: { type: 'object' },
};
const request = (id, method, params) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

test('Beta profile is explicitly opt-in while published v1.0 default stays pinned', () => {
  assert.equal(DEFAULT_MCP_EVENTS_COMPATIBILITY_PROFILE,
    'experimental-extension-2026-09-25');
  const profile = getMcpEventsCompatibilityProfile(betaId);
  assert.equal(profile.id, betaId);
  assert.equal(profile.protocolRevisionMin, '2026-07-28');
  assert.equal(profile.extensionId, extensionId);
  assert.equal(profile.listMethod, 'events/list');
  assert.equal(profile.pollMethod, 'events/poll');
  assert.equal(profile.experimental, false);
  assert.equal(MCP_EVENTS_CAPABILITY_KEY, extensionId);
  assert.deepEqual(MCP_EVENTS_CAPABILITY, { listChanged: false });
  assert.equal(
    resolveMcpEventsCompatibilityProfile({
      requested: betaId,
      capabilities: { extensions: { [extensionId]: { listChanged: false } } },
    })?.id,
    betaId,
  );
  assert.equal(
    resolveMcpEventsCompatibilityProfile({
      requested: betaId,
      capabilities: { extensions: {} },
    }),
    null,
  );
  assert.throws(
    () => getMcpEventsCompatibilityProfile('unknown-beta'),
    error => error?.code === 'MCP_EVENTS_PROFILE_UNKNOWN',
  );
});

test('Beta provider rejects fractional/invalid maxAgeMs before poll callback', async () => {
  let calls = 0;
  let last;
  const provider = createMcpEventsProvider({
    events: [{
      descriptor,
      poll: async params => {
        calls += 1;
        last = params;
        return { events: [], cursor: null, truncated: false, hasMore: false, nextPollMs: 1000 };
      },
    }],
  });

  const good = await provider.handleRequest(
    request(1, 'events/poll', { name, arguments: {}, cursor: null, maxAgeMs: 300000 }),
  );
  assert.equal(good.result.resultType, 'complete');
  assert.equal(good.result.cursor, null);
  assert.equal(last.maxAgeMs, 300000);
  assert.equal(calls, 1);

  const omitted = await provider.handleRequest(
    request(2, 'events/poll', { name, arguments: {} }),
  );
  assert.equal(omitted.result.resultType, 'complete');
  assert.equal(last.cursor, null);
  assert.equal(calls, 2);

  for (const maxAgeMs of [0.5, -1, '1000', Number.POSITIVE_INFINITY, NaN,
    Number.MAX_SAFE_INTEGER + 1]) {
    const bad = await provider.handleRequest(
      request(3, 'events/poll', { name, arguments: {}, cursor: null, maxAgeMs }),
    );
    assert.equal(bad.error?.code, -32602, String(maxAgeMs));
    assert.equal(calls, 2, 'invalid value reached provider poll callback');
  }

  const list = await provider.handleRequest(request(4, 'events/list', {}));
  assert.equal(list.result.resultType, 'complete');
  assert.deepEqual(list.result.events.map(event => event.name), [name]);
  assert.equal(list.result.nextCursor, undefined);

  const unsupported = await provider.handleRequest(request(5, 'events/stream', {}));
  assert.equal(unsupported.error?.code, -32601,
    'poll-only reference adapter must not claim a native stream');
});

test('Beta reference server enforces identical maxAgeMs rules in RPC and direct poll', async () => {
  const server = new ExperimentalMcpEventsServer({
    latestMcpEventSequence: () => 3,
    listMcpOccurrencesAfter: () => [],
  });
  server.registerEvent({ descriptor, matcher: () => true });

  const good = await server.handleRequest(request(1, 'events/poll', {
    name, arguments: {}, cursor: null, maxAgeMs: 0,
  }));
  assert.equal(good.result.resultType, 'complete');
  assert.deepEqual(good.result.events, []);
  assert.equal(typeof good.result.cursor, 'string');

  const omitted = await server.handleRequest(request(2, 'events/poll', { name }));
  assert.equal(omitted.result.resultType, 'complete');
  assert.deepEqual(omitted.result.events, []);

  for (const maxAgeMs of [0.5, -1, '1000', Number.POSITIVE_INFINITY, NaN,
    Number.MAX_SAFE_INTEGER + 1]) {
    const bad = await server.handleRequest(
      request(3, 'events/poll', { name, cursor: null, maxAgeMs }),
    );
    assert.equal(bad.error?.code, -32602, String(maxAgeMs));
    await assert.rejects(server.poll({ name, cursor: null, maxAgeMs }),
      /maxAgeMs must be a non-negative safe integer/);
  }

  const list = await server.handleRequest(request(4, 'events/list'));
  assert.equal(list.result.resultType, 'complete');
  assert.equal(list.result.events[0].name, name);
  const unknown = await server.handleRequest(request(5, 'events/poll', {
    name: 'unknown', cursor: null,
  }));
  assert.equal(unknown.error.code, -32023);
  assert.deepEqual(unknown.error.data, { kind: 'event' });
});
