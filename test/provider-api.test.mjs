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

function invoiceDescriptor() {
  return {
    name: 'erpnext.sales_invoice.submitted',
    description: 'A submitted Sales Invoice was observed.',
    delivery: ['poll'],
    inputSchema: {
      type: 'object',
      required: ['company'],
      properties: {
        company: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    payloadSchema: {
      type: 'object',
      required: ['name', 'company', 'grand_total'],
      properties: {
        name: { type: 'string', minLength: 1 },
        company: { type: 'string', minLength: 1 },
        grand_total: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    _meta: { owner: 'erp' },
  };
}

function orderDescriptor() {
  return {
    name: 'erpnext.sales_order.created',
    description: 'A Sales Order was newly observed.',
    delivery: ['poll'],
    inputSchema: { type: 'object' },
    payloadSchema: {
      type: 'object',
      required: ['name', 'company'],
      properties: {
        name: { type: 'string' },
        company: { type: 'string' },
      },
    },
  };
}

test('provider exports current extension capability and paginates events/list', async () => {
  assert.equal(MCP_EVENTS_CAPABILITY_KEY, 'io.modelcontextprotocol/events');
  assert.deepEqual(MCP_EVENTS_CAPABILITY, { listChanged: false });

  const provider = createMcpEventsProvider({
    listPageSize: 1,
    events: [
      {
        descriptor: invoiceDescriptor(),
        poll: async () => ({ events: [], cursor: null }),
      },
      {
        descriptor: orderDescriptor(),
        poll: async () => ({ events: [], cursor: null }),
      },
    ],
  });

  const first = await provider.handleRequest(request(1, 'events/list', {}));
  assert.equal(first.result.events.length, 1);
  assert.equal(first.result.events[0].name, 'erpnext.sales_invoice.submitted');
  assert.deepEqual(first.result.events[0]._meta, { owner: 'erp' });
  assert.equal(typeof first.result.nextCursor, 'string');

  const second = await provider.handleRequest(
    request(2, 'events/list', { cursor: first.result.nextCursor }),
  );
  assert.deepEqual(
    second.result.events.map((event) => event.name),
    ['erpnext.sales_order.created'],
  );
  assert.equal(second.result.nextCursor, undefined);
});

test('provider validates subscription arguments and preserves nullable cursor and _meta', async () => {
  const calls = [];
  const provider = createMcpEventsProvider({
    events: [{
      descriptor: invoiceDescriptor(),
      poll: async (input) => {
        calls.push(input);
        return {
          events: input.cursor === null
            ? []
            : [{
                eventId: 'invoice-1',
                name: 'erpnext.sales_invoice.submitted',
                timestamp: '2026-09-25T10:00:00.000Z',
                data: {
                  name: 'SINV-1',
                  company: input.arguments.company,
                  grand_total: 1500,
                },
                _meta: { source: 'erpnext' },
              }],
          cursor: input.cursor === null ? 'c0' : null,
          nextPollMs: 12000,
        };
      },
    }],
  });

  const baseline = await provider.handleRequest(
    request(1, 'events/poll', {
      name: 'erpnext.sales_invoice.submitted',
      arguments: { company: 'ACME' },
      cursor: null,
      maxEvents: 25,
    }),
    { tenantId: 'tenant-a' },
  );
  assert.equal(baseline.result.cursor, 'c0');
  assert.equal(baseline.result.events.length, 0);

  const next = await provider.handleRequest(
    request(2, 'events/poll', {
      name: 'erpnext.sales_invoice.submitted',
      arguments: { company: 'ACME' },
      cursor: 'c0',
      maxEvents: 25,
    }),
    { tenantId: 'tenant-a' },
  );
  assert.equal(next.result.cursor, null);
  assert.equal(next.result.events[0].eventId, 'invoice-1');
  assert.deepEqual(next.result.events[0]._meta, { source: 'erpnext' });
  assert.deepEqual(calls[1].arguments, { company: 'ACME' });
  assert.deepEqual(calls[1].context, { tenantId: 'tenant-a' });
});

test('provider returns draft error semantics for invalid args and unknown events', async () => {
  const provider = createMcpEventsProvider({
    events: [{
      descriptor: invoiceDescriptor(),
      poll: async () => ({ events: [], cursor: null }),
    }],
  });

  const invalid = await provider.handleRequest(
    request(1, 'events/poll', {
      name: 'erpnext.sales_invoice.submitted',
      arguments: {},
      cursor: null,
    }),
  );
  assert.equal(invalid.error.code, -32602);

  const missing = await provider.handleRequest(
    request(2, 'events/poll', {
      name: 'missing.event',
      arguments: {},
      cursor: null,
    }),
  );
  assert.equal(missing.error.code, -32011);
  assert.deepEqual(missing.error.data, { kind: 'event' });
});

test('provider fails internally on invalid occurrence or payload emitted by an implementation', async () => {
  const invalidOccurrence = createMcpEventsProvider({
    events: [{
      descriptor: invoiceDescriptor(),
      poll: async () => ({
        cursor: 'next',
        events: [{
          eventId: 'bad-1',
          name: 'erpnext.sales_invoice.submitted',
          timestamp: 'not-a-timestamp',
          data: {
            name: 'SINV-1',
            company: 'ACME',
            grand_total: 10,
          },
        }],
      }),
    }],
  });

  const occurrenceResult = await invalidOccurrence.handleRequest(
    request(1, 'events/poll', {
      name: 'erpnext.sales_invoice.submitted',
      arguments: { company: 'ACME' },
      cursor: 'start',
    }),
  );
  assert.equal(occurrenceResult.error.code, -32603);
  assert.match(occurrenceResult.error.message, /invalid EventOccurrence/i);

  const invalidPayload = createMcpEventsProvider({
    events: [{
      descriptor: invoiceDescriptor(),
      poll: async () => ({
        cursor: 'next',
        events: [{
          eventId: 'bad-2',
          name: 'erpnext.sales_invoice.submitted',
          timestamp: '2026-09-20T11:31:00.000Z',
          data: {
            name: 'SINV-2',
            company: 'ACME',
          },
        }],
      }),
    }],
  });

  const payloadResult = await invalidPayload.handleRequest(
    request(2, 'events/poll', {
      name: 'erpnext.sales_invoice.submitted',
      arguments: { company: 'ACME' },
      cursor: 'start',
    }),
  );
  assert.equal(payloadResult.error.code, -32603);
  assert.match(payloadResult.error.message, /missing required property grand_total/i);
});

test('provider rejects duplicates and unknown methods deterministically', async () => {
  assert.throws(
    () =>
      createMcpEventsProvider({
        events: [
          {
            descriptor: orderDescriptor(),
            poll: async () => ({ events: [], cursor: null }),
          },
          {
            descriptor: orderDescriptor(),
            poll: async () => ({ events: [], cursor: null }),
          },
        ],
      }),
    /Duplicate MCP provider event/,
  );

  const provider = createMcpEventsProvider({
    events: [{
      descriptor: orderDescriptor(),
      poll: async () => ({ events: [], cursor: null }),
    }],
  });
  const unknown = await provider.handleRequest(request(4, 'events/subscribe'));
  assert.equal(unknown.error.code, -32601);
});
