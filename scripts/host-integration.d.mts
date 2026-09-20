import type {
  ActivationEnvelope,
  TriggerPlanInput,
} from '../dist/src/intelligenceProtocol/index.js';

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
  /** Isolation partition used by the shared EI host. Defaults to \"default\". */
  scopeId?: string;
  pollIntervalMs?: number;
  maxEvents?: number;
  /** Maximum number of immediately drained pages when the provider reports hasMore. */
  maxPollBatches?: number;
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
  activation?: ActivationEnvelope,
) => Promise<HostWakeReceipt | string> | HostWakeReceipt | string;

export interface EventIntelligenceStore {
  init?(): Promise<unknown>;
  /** Required when non-default scopes are used. Implementations should return an isolated store view. */
  forScope?(scopeId: string): Promise<EventIntelligenceStore> | EventIntelligenceStore;
  listScopeIds?(): Promise<string[]> | string[];
  [key: string]: any;
}

export interface EventIntelligenceHostOptions {
  dataDir?: string;
  /** Optional storage backend. PersistentEventStore is used when omitted. */
  store?: EventIntelligenceStore;
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

export interface EventIntelligenceScopedHost {
  readonly scopeId: string;
  readonly runtime: any;
  readonly store: EventIntelligenceStore;
  readonly triggerControl: any;
  readonly triggerInspector: any;
  readonly triggerPlanner: any;
  readonly activationHydrator: any;
  readonly eventSources: any[];
  planTrigger(input: TriggerPlanInput): Promise<{
    planVersion: '1';
    definition: any;
    connectionIds: string[];
    resolvedSources: any[];
    warnings: any[];
    explanation: any;
  }>;
  hydrateWake(wakeId: string): ActivationEnvelope;
  attachMcpClient(connection: HostMcpConnectionOptions): Promise<{
    connectionId: string;
    events: any[];
  }>;
  mcpStatus(): any[];
}

export interface EventIntelligenceHost extends EventIntelligenceScopedHost {
  refreshMcpRegistry(): Promise<any[]>;
  detachMcpClient(connectionId: string): Promise<boolean>;
  loadedScopes(): string[];
  scope(scopeId?: string): Promise<EventIntelligenceScopedHost>;
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


export class PersistentEventStore implements EventIntelligenceStore {
  constructor(dataDir: string);
  readonly dataDir: string;
  init(): Promise<unknown>;
  forScope(scopeId?: string): Promise<PersistentEventStore>;
  listScopeIds(): Promise<string[]>;
  [key: string]: any;
}
