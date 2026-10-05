import type {
  ActivationEnvelope,
  RuntimeTarget,
} from '../dist/src/intelligenceProtocol/index.js';

export type {
  ActivationEnvelope as EventActivation,
  RuntimeTarget as ContinuationTarget,
};

import type {
  EventIntelligenceHost,
  EventIntelligenceHostOptions,
  HostMcpConnectionOptions,
  HostMcpRegistry,
  HostWakeHandler,
  HostWakeReceipt,
} from './host-integration.d.mts';

export interface EmbeddedHostIdentity {
  type: string;
  principal_id: string;
  tenant_id?: string;
}

export interface EmbeddedToolContext {
  scopeId?: string;
  target: RuntimeTarget;
  actor?: EmbeddedHostIdentity;
  owner?: EmbeddedHostIdentity;
  confirmationId?: string;
  [key: string]: unknown;
}

export interface EventIntelligenceCapabilityMetadata {
  id: string;
  operation: 'read' | 'create' | 'update' | 'delete' | string;
  resource: string;
  effect: 'none' | 'durable-state' | string;
  durability: 'ephemeral' | 'durable' | string;
  hostControl: 'none' | 'required' | string;
}

export interface PortableResultReference {
  id: string;
  kind?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PortableProjectedResult {
  inline?: unknown;
  reference?: PortableResultReference;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface PortableToolResult {
  ok: boolean;
  data?: any;
  result?: PortableProjectedResult;
  error?: {
    code: string;
    message: string;
  };
  [key: string]: unknown;
}

export interface PortableAgentTool<RuntimeContext = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  capability: EventIntelligenceCapabilityMetadata;
  execute(
    args: unknown,
    runtimeContext: RuntimeContext,
  ): Promise<PortableToolResult>;
}

/** @deprecated Prefer the host-owned control() contract. */
export interface AuthorizationDecision {
  allowed: boolean;
  code?: string;
  message?: string;
  actor?: EmbeddedHostIdentity;
  owner?: EmbeddedHostIdentity;
  confirmationId?: string;
}

export interface HostControlExecuteDecision {
  action: 'execute';
  execution?: {
    actor?: EmbeddedHostIdentity;
    owner?: EmbeddedHostIdentity;
    /** Host policy/approval receipt persisted by EI as confirmation provenance. */
    receiptId?: string;
    /** Legacy alias accepted for compatibility. */
    confirmationId?: string;
    [key: string]: unknown;
  };
}

export interface HostControlReturnDecision {
  action: 'return';
  /**
   * Opaque host-owned outcome. It may represent deny, approval required,
   * interruption, deferral or another runtime-specific control path.
   * EI does not interpret the reason.
   */
  result: PortableToolResult;
}

export type HostControlDecision =
  | HostControlExecuteDecision
  | HostControlReturnDecision;

export interface ActivationDeliveryInput<Target = unknown> {
  packet: Record<string, unknown>;
  activation: ActivationEnvelope;
  target: Target;
  receiptId: string;
}

export interface ActivationDispatcherOptions<Target = RuntimeTarget> {
  resolveTarget?: (
    target: RuntimeTarget,
    activation: ActivationEnvelope,
  ) => Target | null | Promise<Target | null>;
  hasReceipt?: (
    receiptId: string,
    activation: ActivationEnvelope,
  ) => boolean | Promise<boolean>;
  receiptId?: (input: {
    packet: Record<string, unknown>;
    activation: ActivationEnvelope;
  }) => string | Promise<string>;
  deliver(
    input: ActivationDeliveryInput<Target>,
  ): HostWakeReceipt | string | void | Promise<HostWakeReceipt | string | void>;
}

export type EventSourceConnection = HostMcpConnectionOptions;

export interface EventSourceRegistry {
  list(): Iterable<EventSourceConnection> | Promise<Iterable<EventSourceConnection>>;
  subscribe?: (listener: () => void) => void | (() => void);
}

export interface EventSourceRegistryOptions {
  list(): Iterable<EventSourceConnection> | Promise<Iterable<EventSourceConnection>>;
  subscribe?: (listener: () => void) => void | (() => void);
}

export interface PortableToolCatalog<RuntimeContext = unknown> {
  readonly all: readonly PortableAgentTool<RuntimeContext>[];
  get(name: string): PortableAgentTool<RuntimeContext> | null;
  list(options?: {
    capabilityIds?: Iterable<string>;
  }): PortableAgentTool<RuntimeContext>[];
  capabilities(): EventIntelligenceCapabilityMetadata[];
}

export interface EventIntelligenceAgentToolsOptions<RuntimeContext = unknown> {
  host: EventIntelligenceHost;
  resolveContext(
    runtimeContext: RuntimeContext,
    request: {
      action: 'event.sources.list' | 'trigger.create';
      capability: EventIntelligenceCapabilityMetadata;
      input?: unknown;
    },
  ): EmbeddedToolContext | Promise<EmbeddedToolContext>;

  /**
   * Host-owned control gate for durable mutations.
   *
   * Return action:'execute' to allow EI to perform the mutation, or
   * action:'return' with a fully host-owned PortableToolResult to represent
   * deny/interrupt/approval/defer semantics without EI interpreting them.
   */
  control?(input: {
    capability: EventIntelligenceCapabilityMetadata;
    action: 'trigger.create';
    runtimeContext: RuntimeContext;
    context: EmbeddedToolContext;
    input: unknown;
    plan: any;
  }): HostControlDecision | Promise<HostControlDecision>;

  /**
   * Host-owned result projection. Use it to inline, summarize or externalize
   * large results behind a runtime-specific reference.
   */
  projectResult?(input: {
    capability: EventIntelligenceCapabilityMetadata;
    runtimeContext: RuntimeContext;
    context: EmbeddedToolContext;
    value: unknown;
  }): PortableProjectedResult | void | Promise<PortableProjectedResult | void>;

  /**
   * @deprecated Compatibility only. New integrations should use control().
   */
  authorize?(input: {
    action: 'trigger.create';
    runtimeContext: RuntimeContext;
    context: EmbeddedToolContext;
    input: unknown;
    plan: any;
  }):
    | boolean
    | AuthorizationDecision
    | Promise<boolean | AuthorizationDecision>;

  names?: {
    sources?: string;
    create?: string;
  };
}

export interface EmbeddedEventIntelligenceOptions<RuntimeContext = unknown>
  extends Omit<EventIntelligenceHostOptions, 'wake' | 'mcpRegistry'> {
  mcpRegistry?: HostMcpRegistry;
  mcp?: {
    listConnections(): Iterable<HostMcpConnectionOptions> | Promise<Iterable<HostMcpConnectionOptions>>;
    subscribe?: (listener: () => void) => void | (() => void);
  };
  activation?: ActivationDispatcherOptions<any>;
  wake?: HostWakeHandler;
  agentTools?: Omit<EventIntelligenceAgentToolsOptions<RuntimeContext>, 'host'>;
  /** Test/advanced injection; normal callers should omit it. */
  createHost?: (options: EventIntelligenceHostOptions) => Promise<EventIntelligenceHost>;
}

export interface EmbeddedEventIntelligence<RuntimeContext = unknown> {
  readonly host: EventIntelligenceHost;
  readonly runtime: any;
  readonly tools: PortableAgentTool<RuntimeContext>[];
  createAgentTools<Context = RuntimeContext>(
    options: Omit<EventIntelligenceAgentToolsOptions<Context>, 'host'>,
  ): PortableAgentTool<Context>[];
  refresh(): Promise<any[]>;
  status(): Promise<any[]> | any[];
  scope(scopeId?: string): ReturnType<EventIntelligenceHost['scope']>;
  close(): Promise<void>;
}

export interface EmbeddedRuntimeTooling<RuntimeContext = unknown> {
  resolveContext: EventIntelligenceAgentToolsOptions<RuntimeContext>['resolveContext'];
  control: NonNullable<EventIntelligenceAgentToolsOptions<RuntimeContext>['control']>;
  projectResult?: EventIntelligenceAgentToolsOptions<RuntimeContext>['projectResult'];
  names?: {
    sources?: string;
    create?: string;
  };
}

export interface EmbeddedRuntimeIntegrationOptions<RuntimeContext = unknown>
  extends Omit<
    EmbeddedEventIntelligenceOptions<RuntimeContext>,
    'mcpRegistry' | 'mcp' | 'agentTools'
  > {
  eventSources?: EventSourceRegistry | EventSourceRegistryOptions;
  tooling?: EmbeddedRuntimeTooling<RuntimeContext>;
}

export interface EmbeddedRuntimeIntegration<RuntimeContext = unknown>
  extends Omit<EmbeddedEventIntelligence<RuntimeContext>, 'tools'> {
  readonly tools: readonly PortableAgentTool<RuntimeContext>[];
  readonly toolCatalog: PortableToolCatalog<RuntimeContext>;
  readonly capabilities: readonly EventIntelligenceCapabilityMetadata[];
  readonly eventSources: EventSourceRegistry | null;
}

export function createResultReference(
  input: PortableResultReference,
): PortableResultReference;

export function createEventSourceRegistry(
  options: EventSourceRegistryOptions,
): EventSourceRegistry;

export function createPortableToolCatalog<RuntimeContext = unknown>(
  tools?: PortableAgentTool<RuntimeContext>[],
): PortableToolCatalog<RuntimeContext>;

export function createContinuationTarget(input: {
  runtime: string;
  kind: string;
  id: string;
}): RuntimeTarget;

export function createActivationDispatcher<Target = RuntimeTarget>(
  options: ActivationDispatcherOptions<Target>,
): HostWakeHandler;

export function createEventIntelligenceAgentTools<RuntimeContext = unknown>(
  options: EventIntelligenceAgentToolsOptions<RuntimeContext>,
): PortableAgentTool<RuntimeContext>[];

export function createEmbeddedEventIntelligence<RuntimeContext = unknown>(
  options?: EmbeddedEventIntelligenceOptions<RuntimeContext>,
): Promise<EmbeddedEventIntelligence<RuntimeContext>>;

export function createEmbeddedRuntimeIntegration<RuntimeContext = unknown>(
  options: EmbeddedRuntimeIntegrationOptions<RuntimeContext>,
): Promise<EmbeddedRuntimeIntegration<RuntimeContext>>;

export const EVENT_INTELLIGENCE_CAPABILITIES: Readonly<{
  eventSourcesList: Readonly<EventIntelligenceCapabilityMetadata>;
  triggerCreate: Readonly<EventIntelligenceCapabilityMetadata>;
}>;

export const PORTABLE_EVENT_INTELLIGENCE_TOOL_NAMES: Readonly<{
  sources: 'event_sources_list';
  create: 'trigger_create';
}>;