import type {
  ActivationEnvelope,
  RuntimeTarget,
} from '../dist/src/intelligenceProtocol/index.js';
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
  actor: EmbeddedHostIdentity;
  owner: EmbeddedHostIdentity;
  confirmationId?: string;
  [key: string]: unknown;
}

export interface PortableToolResult {
  ok: boolean;
  data?: any;
  error?: {
    code: string;
    message: string;
  };
}

export interface PortableAgentTool<RuntimeContext = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(
    args: unknown,
    runtimeContext: RuntimeContext,
  ): Promise<PortableToolResult>;
}

export interface AuthorizationDecision {
  allowed: boolean;
  code?: string;
  message?: string;
  actor?: EmbeddedHostIdentity;
  owner?: EmbeddedHostIdentity;
  confirmationId?: string;
}

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

export interface EventIntelligenceAgentToolsOptions<RuntimeContext = unknown> {
  host: EventIntelligenceHost;
  resolveContext(
    runtimeContext: RuntimeContext,
    request: {
      action: 'event.sources.list' | 'trigger.create';
      input?: unknown;
    },
  ): EmbeddedToolContext | Promise<EmbeddedToolContext>;
  authorize(input: {
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

export const PORTABLE_EVENT_INTELLIGENCE_TOOL_NAMES: Readonly<{
  sources: 'event_sources_list';
  create: 'trigger_create';
}>;
