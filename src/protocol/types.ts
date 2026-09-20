export type JsonRpcId = string | number;

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: T;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError;

export interface EventDescriptor {
  name: string;
  description: string;
  delivery: Array<'poll' | 'push' | 'webhook'>;
  inputSchema: Record<string, unknown>;
  payloadSchema: Record<string, unknown>;
}

export interface EventOccurrence<
  TData extends Record<string, unknown> = Record<string, unknown>,
> {
  eventId: string;
  name: string;
  timestamp: string;
  data: TData;
  cursor?: string | null;
  _meta?: Record<string, unknown>;
}
