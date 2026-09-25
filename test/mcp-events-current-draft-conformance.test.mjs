import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCP_EVENTS_CAPABILITY,
  MCP_EVENTS_CAPABILITY_KEY,
  createMcpEventsProvider,
} from '../dist/src/mcpEvents/provider.js';

function request(id, method, params) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

test('draft conformance regression: discovery and poll contract', async () => {
  assert.equal(MCP_EVENTS_CAPABILITY_KEY, 'io.modelcontextprotocol/events');
  assert.equal(typeof MCP_EVENTS_CAPABILITY, 'object');
  assert.equal(MCP_EVENTS_CAPABILITY.listChanged, false);

  let sequence = 0;
  const provider = createMcpEventsProvider({
    listPageSize: 1,
    events: [
      {
        descriptor: {
          name: 'fixture.changed',
          description: 'A fixture changed.',
          delivery: ['poll'],
          inputSchema: {
            type: 'object',
            required: ['scope'],
            properties: { scope: { type: 'string' } },
            additionalProperties: false,
          },
          payloadSchema: {
            type: 'object',
            required: ['scope', 'sequence'],
            properties: {
              scope: { type: 'string' },
              sequence: { type: 'integer' },
            },
            additionalProperties: false,
          },
          _meta: { fixture: true },
        },
        poll: async ({ cursor, arguments: args, maxEvents }) => {
          if (cursor === null) {
            return {
              events: [],
              cursor: 'fixture:0',
              truncated: false,
              hasMore: false,
              nextPollMs: 2500,
            };
          }
          sequence += 1;
          const available = [
            {
              eventId: `fixture-${sequence}`,
              name: 'fixture.changed',
              timestamp: '2026-09-25T10:00:00.000Z',
              data: { scope: args.scope, sequence },
              _meta: { producer: 'fixture' },
            },
            {
              eventId: `fixture-${sequence + 1}`,
              name: 'fixture.changed',
              timestamp: '2026-09-25T10:00:01.000Z',
              data: { scope: args.scope, sequence: sequence + 1 },
            },
          ];
          const events = available.slice(0, maxEvents);
          return {
            events,
            cursor: `fixture:${sequence + events.length}`,
            truncated: false,
            hasMore: available.length > events.length,
            nextPollMs: available.length > events.length ? 0 : 2500,
          };
        },
      },
      {
        descriptor: {
          name: 'fixture.no_replay',
          description: 'A fixture without addressable history.',
          delivery: ['poll'],
          inputSchema: { type: 'object', additionalProperties: false },
          payloadSchema: { type: 'object' },
        },
        poll: async () => ({
          events: [],
          cursor: null,
          truncated: false,
          hasMore: false,
          nextPollMs: 5000,
        }),
      },
    ],
  });

  const firstPage = await provider.handleRequest(
    request(1, 'events/list', {}),
  );
  assert.equal(firstPage.result.events.length, 1);
  const descriptor = firstPage.result.events[0];
  assert.equal(typeof descriptor.name, 'string');
  assert.equal(typeof descriptor.description, 'string');
  assert.deepEqual(descriptor.delivery, ['poll']);
  assert.equal(typeof descriptor.inputSchema, 'object');
  assert.equal(typeof descriptor.payloadSchema, 'object');
  assert.deepEqual(descriptor._meta, { fixture: true });
  assert.equal(typeof firstPage.result.nextCursor, 'string');

  const secondPage = await provider.handleRequest(
    request(2, 'events/list', { cursor: firstPage.result.nextCursor }),
  );
  assert.equal(secondPage.result.events.length, 1);
  assert.equal(secondPage.result.nextCursor, undefined);

  const invalidArguments = await provider.handleRequest(
    request(3, 'events/poll', {
      name: 'fixture.changed',
      arguments: {},
      cursor: null,
    }),
  );
  assert.equal(invalidArguments.error.code, -32602);

  const unknown = await provider.handleRequest(
    request(4, 'events/poll', {
      name: 'fixture.unknown',
      arguments: {},
      cursor: null,
    }),
  );
  assert.equal(unknown.error.code, -32011);
  assert.deepEqual(unknown.error.data, { kind: 'event' });

  const bootstrap = await provider.handleRequest(
    request(5, 'events/poll', {
      name: 'fixture.changed',
      arguments: { scope: 'alpha' },
      cursor: null,
      maxEvents: 1,
    }),
  );
  assert.deepEqual(bootstrap.result.events, []);
  assert.equal(bootstrap.result.cursor, 'fixture:0');
  assert.equal(bootstrap.result.truncated, false);
  assert.equal(bootstrap.result.hasMore, false);
  assert.equal(bootstrap.result.nextPollMs, 2500);

  const partial = await provider.handleRequest(
    request(6, 'events/poll', {
      name: 'fixture.changed',
      arguments: { scope: 'alpha' },
      cursor: bootstrap.result.cursor,
      maxEvents: 1,
    }),
  );
  assert.equal(partial.result.events.length, 1);
  assert.equal(partial.result.events[0].name, 'fixture.changed');
  assert.equal(partial.result.events[0].data.scope, 'alpha');
  assert.deepEqual(partial.result.events[0]._meta, { producer: 'fixture' });
  assert.equal(partial.result.hasMore, true);
  assert.equal(partial.result.truncated, false);
  assert.equal(partial.result.nextPollMs, 0);

  const noReplay = await provider.handleRequest(
    request(7, 'events/poll', {
      name: 'fixture.no_replay',
      arguments: {},
      cursor: null,
    }),
  );
  assert.equal(noReplay.result.cursor, null);

  const unsupported = await provider.handleRequest(
    request(8, 'events/stream', {}),
  );
  assert.equal(unsupported.error.code, -32601);
});
