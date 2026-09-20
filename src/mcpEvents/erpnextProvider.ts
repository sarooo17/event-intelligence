import {
  createMcpEventsProvider,
  type McpEventsProvider,
  type ProviderPollRequest,
} from './provider.js';
import type {
  EventOccurrence,
} from '../protocol/types.js';

export type ErpNextEventName =
  | 'erpnext.sales_invoice.submitted'
  | 'erpnext.sales_order.created';

export interface ErpNextProviderPollResult {
  events: Array<{
    eventId: string;
    timestamp: string;
    data: Record<string, unknown>;
  }>;
  cursor: string;
  hasMore?: boolean;
  nextPollMs?: number;
}

export type ErpNextEventPoller<TContext = unknown> = (
  request: ProviderPollRequest<TContext>,
) => ErpNextProviderPollResult | Promise<ErpNextProviderPollResult>;

export interface CreateErpNextEventsProviderOptions<TContext = unknown> {
  pollSalesInvoices: ErpNextEventPoller<TContext>;
  pollSalesOrders: ErpNextEventPoller<TContext>;
  supportedVersions?: string[];
  instructions?: string;
}

function toOccurrences(
  name: ErpNextEventName,
  result: ErpNextProviderPollResult,
): EventOccurrence[] {
  return result.events.map((event) => ({
    eventId: String(event.eventId),
    name,
    timestamp: String(event.timestamp),
    data: event.data,
  }));
}

export function createErpNextEventsProvider<TContext = unknown>(
  options: CreateErpNextEventsProviderOptions<TContext>,
): McpEventsProvider<TContext> {
  if (!options || typeof options.pollSalesInvoices !== 'function') {
    throw new Error('ERPNext Events provider requires pollSalesInvoices()');
  }
  if (typeof options.pollSalesOrders !== 'function') {
    throw new Error('ERPNext Events provider requires pollSalesOrders()');
  }

  return createMcpEventsProvider<TContext>({
    supportedVersions: options.supportedVersions,
    instructions:
      options.instructions ??
      'ERPNext MCP Events adapter exposing host-owned Sales Invoice and Sales Order changes.',
    events: [
      {
        descriptor: {
          name: 'erpnext.sales_invoice.submitted',
          description: 'A Sales Invoice reached submitted status in ERPNext.',
          delivery: ['poll'],
          inputSchema: {},
          payloadSchema: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string', minLength: 1 },
              company: { type: 'string' },
              customer: { type: 'string' },
              grand_total: { type: 'number' },
              currency: { type: 'string' },
            },
          },
        },
        poll: async (request) => {
          const result = await options.pollSalesInvoices(request);
          return {
            events: toOccurrences(
              'erpnext.sales_invoice.submitted',
              result,
            ),
            cursor: result.cursor,
            hasMore: result.hasMore ?? false,
            nextPollMs: result.nextPollMs ?? 5000,
          };
        },
      },
      {
        descriptor: {
          name: 'erpnext.sales_order.created',
          description: 'A Sales Order was created in ERPNext.',
          delivery: ['poll'],
          inputSchema: {},
          payloadSchema: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string', minLength: 1 },
              company: { type: 'string' },
              customer: { type: 'string' },
              grand_total: { type: 'number' },
              currency: { type: 'string' },
            },
          },
        },
        poll: async (request) => {
          const result = await options.pollSalesOrders(request);
          return {
            events: toOccurrences(
              'erpnext.sales_order.created',
              result,
            ),
            cursor: result.cursor,
            hasMore: result.hasMore ?? false,
            nextPollMs: result.nextPollMs ?? 5000,
          };
        },
      },
    ],
  });
}
