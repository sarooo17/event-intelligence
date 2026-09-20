import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createErpNextEventsProvider,
} from '../dist/src/mcpEvents/erpnextProvider.js';

test('ERPNext provider adapter exposes invoice and order events through the generic MCP Events contract', async () => {
  const calls = [];
  const provider = createErpNextEventsProvider({
    pollSalesInvoices: async (request) => {
      calls.push({ kind: 'invoice', request });
      return {
        events: [{
          eventId: 'sales-invoice:SINV-0001:submitted',
          timestamp: '2026-09-20T14:30:00.000Z',
          data: {
            name: 'SINV-0001',
            company: 'Acme',
            customer: 'Customer A',
            grand_total: 1200,
            currency: 'EUR',
          },
        }],
        cursor: 'invoice-cursor-1',
        hasMore: false,
      };
    },
    pollSalesOrders: async (request) => {
      calls.push({ kind: 'order', request });
      return {
        events: [{
          eventId: 'sales-order:SO-0001:created',
          timestamp: '2026-09-20T14:31:00.000Z',
          data: {
            name: 'SO-0001',
            company: 'Acme',
            customer: 'Customer B',
            grand_total: 900,
            currency: 'EUR',
          },
        }],
        cursor: 'order-cursor-1',
      };
    },
  });

  const listed = await provider.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'events/list',
  });
  assert.deepEqual(
    listed.result.events.map((event) => event.name).sort(),
    [
      'erpnext.sales_invoice.submitted',
      'erpnext.sales_order.created',
    ],
  );

  const invoice = await provider.handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'events/poll',
    params: {
      name: 'erpnext.sales_invoice.submitted',
      cursor: null,
      arguments: {},
      maxEvents: 10,
    },
  }, { tenant: 'tenant-a' });

  assert.equal(invoice.result.events[0].name, 'erpnext.sales_invoice.submitted');
  assert.equal(invoice.result.events[0].data.name, 'SINV-0001');
  assert.equal(invoice.result.cursor, 'invoice-cursor-1');
  assert.equal(calls[0].request.context.tenant, 'tenant-a');

  const order = await provider.handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'events/poll',
    params: {
      name: 'erpnext.sales_order.created',
      cursor: null,
      arguments: {},
      maxEvents: 10,
    },
  });

  assert.equal(order.result.events[0].name, 'erpnext.sales_order.created');
  assert.equal(order.result.events[0].data.name, 'SO-0001');
  assert.equal(order.result.cursor, 'order-cursor-1');
});

test('ERPNext provider adapter still enforces MCP payload schemas', async () => {
  const provider = createErpNextEventsProvider({
    pollSalesInvoices: async () => ({
      events: [{
        eventId: 'invalid-invoice',
        timestamp: '2026-09-20T14:30:00.000Z',
        data: { grand_total: 100 },
      }],
      cursor: 'cursor',
    }),
    pollSalesOrders: async () => ({
      events: [],
      cursor: 'cursor',
    }),
  });

  const result = await provider.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'events/poll',
    params: {
      name: 'erpnext.sales_invoice.submitted',
      cursor: null,
      arguments: {},
      maxEvents: 10,
    },
  });

  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /missing required property name/);
});
