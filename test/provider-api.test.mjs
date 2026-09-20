import assert from 'node:assert/strict';
import test from 'node:test';
import {
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

test('provider adapter advertises Events and lists domain descriptors', async () => {
  const provider = createMcpEventsProvider({
    events: [
      {
        descriptor: invoiceDescriptor(),
        poll: async () => ({ events: [], cursor: 'invoice:0' }),
      },
      {
        descriptor: orderDescriptor(),
        poll: async () => ({ events: [], cursor: 'order:0' }),
      },
    ],
  });

  const discover = await provider.handleRequest(request(1, 'server/discover'));
  assert.equal(
    discover.result.capabilities.experimental[MCP_EVENTS_CAPABILITY_KEY].status,
    'draft',
  );
  assert.deepEqual(
    discover.result.capabilities.experimental[MCP_EVENTS_CAPABILITY_KEY].methods,
    ['events/list', 'events/poll'],
  );

  const listed = await provider.handleRequest(request(2, 'events/list'));
  assert.deepEqual(
    listed.result.events.map((event) => event.name),
    ['erpnext.sales_invoice.submitted', 'erpnext.sales_order.created'],
  );
});

test('provider adapter passes opaque cursors and request context without owning provider state', async () => {
  const calls = [];
  const provider = createMcpEventsProvider({
    events: [
      {
        descriptor: invoiceDescriptor(),
        poll: async (input) => {
          calls.push(input);
          if (input.cursor === null) {
            return {
              events: [],
              cursor: 'opaque|tenant-a|baseline==',
              nextPollMs: 12000,
            };
          }
          return {
            events: [
              {
                eventId: 'sales-invoice:SINV-0001:submitted',
                name: 'erpnext.sales_invoice.submitted',
                timestamp: '2026-09-20T11:30:00.000Z',
                data: {
                  name: 'SINV-0001',
                  company: 'ACME',
                  grand_total: 1200.5,
                },
              },
            ],
            cursor: 'opaque|tenant-a|next==',
            hasMore: false,
          };
        },
      },
    ],
  });

  const context = { tenantId: 'tenant-a', company: 'ACME' };
  const baseline = await provider.handleRequest(
    request(1, 'events/poll', {
      name: 'erpnext.sales_invoice.submitted',
      cursor: null,
      maxEvents: 25,
    }),
    context,
  );
  assert.equal(baseline.result.cursor, 'opaque|tenant-a|baseline==');
  assert.equal(baseline.result.events.length, 0);
  assert.equal(baseline.result.nextPollMs, 12000);

  const next = await provider.handleRequest(
    request(2, 'events/poll', {
      name: 'erpnext.sales_invoice.submitted',
      cursor: baseline.result.cursor,
      arguments: { company: 'ACME' },
      maxEvents: 25,
    }),
    context,
  );

  assert.equal(next.result.cursor, 'opaque|tenant-a|next==');
  assert.equal(next.result.events.length, 1);
  assert.equal(next.result.events[0].eventId, 'sales-invoice:SINV-0001:submitted');
  assert.equal(calls[1].context, context);
  assert.deepEqual(calls[1].arguments, { company: 'ACME' });
});

test('provider adapter fails closed on invalid occurrence or payload', async () => {
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
      cursor: 'start',
    }),
  );
  assert.equal(occurrenceResult.error.code, -32602);
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
      cursor: 'start',
    }),
  );
  assert.equal(payloadResult.error.code, -32602);
  assert.match(
    payloadResult.error.message,
    /missing required property grand_total/i,
  );
});

test('provider adapter rejects duplicates and unknown methods deterministically', async () => {
  assert.throws(
    () =>
      createMcpEventsProvider({
        events: [
          {
            descriptor: invoiceDescriptor(),
            poll: async () => ({ events: [], cursor: '1' }),
          },
          {
            descriptor: invoiceDescriptor(),
            poll: async () => ({ events: [], cursor: '2' }),
          },
        ],
      }),
    /Duplicate MCP provider event/,
  );

  const provider = createMcpEventsProvider({
    events: [
      {
        descriptor: invoiceDescriptor(),
        poll: async () => ({ events: [], cursor: '1' }),
      },
    ],
  });
  const unknown = await provider.handleRequest(request(4, 'events/subscribe'));
  assert.equal(unknown.error.code, -32601);
});
