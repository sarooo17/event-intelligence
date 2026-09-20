export interface HostMcpClientLike {
  request(
    request: { method: string; params?: unknown },
    resultSchema?: unknown,
  ): Promise<unknown>;
  getServerCapabilities?(): unknown;
}

export interface HostMcpConnectionOptions {
  connectionId?: string;
  id?: string;
  name?: string;
  serverId?: string;
  client?: HostMcpClientLike;
  request?: (method: string, params?: unknown) => Promise<unknown>;
  enabled?: boolean;
  pollIntervalMs?: number;
  maxEvents?: number;
}

export interface HostMcpRegistry {
  listConnections?(): Iterable<HostMcpConnectionOptions> | Promise<Iterable<HostMcpConnectionOptions>>;
  list?(): Iterable<HostMcpConnectionOptions> | Promise<Iterable<HostMcpConnectionOptions>>;
  connections?(): Iterable<HostMcpConnectionOptions> | Promise<Iterable<HostMcpConnectionOptions>>;
  subscribe?(listener: () => void): void | (() => void);
  [Symbol.iterator]?(): Iterator<HostMcpConnectionOptions>;
}

export interface HostWakeReceipt {
  runtimeReceiptId: string;
  duplicate?: boolean;
  status?: string;
}

export type HostWakeHandler = (
  packet: Record<string, unknown>,
) => Promise<HostWakeReceipt | string> | HostWakeReceipt | string;

export interface EventIntelligenceHostOptions {
  dataDir?: string;
  env?: Record<string, string | undefined>;
  mcpRegistry?: HostMcpRegistry;
  /** Low-level/manual fallback; prefer mcpRegistry for automatic discovery. */
  mcpClients?: HostMcpConnectionOptions[];
  /** Generic harness dispatcher. target.id identifies the task/session/agent to resume. */
  wake?: HostWakeHandler;
  /** Optional runtime-specific dispatchers. */
  wakeHandlers?: Map<string, HostWakeHandler> | Record<string, HostWakeHandler>;
  semanticEvaluator?: unknown;
}

export interface EventIntelligenceHost {
  readonly runtime: any;
  readonly store: any;
  readonly triggerControl: any;
  readonly triggerInspector: any;
  readonly eventSources: any[];
  refreshMcpRegistry(): Promise<any[]>;
  attachMcpClient(connection: HostMcpConnectionOptions): Promise<{
    connectionId: string;
    events: any[];
  }>;
  detachMcpClient(connectionId: string): Promise<boolean>;
  mcpStatus(): any[];
  close(): Promise<void>;
}

export function createMcpRegistryAdapter(options: {
  listConnections(): Iterable<HostMcpConnectionOptions> | Promise<Iterable<HostMcpConnectionOptions>>;
  subscribe?: (listener: () => void) => void | (() => void);
}): HostMcpRegistry;

export function createHostMcpEventsConnection(
  options: HostMcpConnectionOptions,
): {
  connectionId: string;
  serverId: string;
  request(method: string, params?: unknown): Promise<unknown>;
  enabled: boolean;
  pollIntervalMs: number;
  maxEvents: number;
};

export function createEventIntelligenceHost(
  options?: EventIntelligenceHostOptions,
): Promise<EventIntelligenceHost>;
