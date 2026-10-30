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
  /** Present for operations with a v1 modeled canonical result shape. */
  outputSchema?: Record<string, unknown>;
  capability: EventIntelligenceCapabilityMetadata;
  execute(
    args: unknown,
    runtimeContext: RuntimeContext,
  ): Promise<PortableToolResult>;
}

export interface HostControlExecuteDecision {
  action: 'execute';
  execution?: {
    actor?: EmbeddedHostIdentity;
    owner?: EmbeddedHostIdentity;
    /** Host policy/approval receipt persisted by EI as confirmation provenance. */
    receiptId?: string;
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
  /** Optional deterministic SHA-256 receipt namespace. Mutually exclusive with receiptId. */
  receiptNamespace?: string;
  /**
   * Reject an unacknowledged/void delivery instead of synthesizing a
   * runtimeReceiptId from the candidate wake ID. The canonical facade
   * enables this when HostContract v1 requires "wake.receipts".
   * This is acknowledgment checking, NOT proof of host-side atomicity.
   */
  requireExplicitReceipt?: boolean;
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

export interface EventSourceDiagnostics {
  readonly connections: number;
  readonly eventsCapable: number;
  readonly eventDefinitions: number;
  readonly errors: number;
  readonly statuses: readonly any[];
  readonly refreshOutcomes: readonly any[];
}

export interface EmbeddedRuntimeBindOptions<
  RuntimeContext = unknown,
  HostTool = unknown,
> {
  adapt(tool: PortableAgentTool<RuntimeContext>): HostTool;
  register(
    tool: HostTool,
    portableTool: PortableAgentTool<RuntimeContext>,
  ): void;
  onClose?(close: () => Promise<void>): void;
  /**
   * Static allowlist for installation/discovery. [] exposes nothing.
   * Unknown IDs fail before any registration. The host must separately
   * enforce actor/tenant authority at every tool execution.
   */
  capabilityIds?: readonly string[];
}

export type EmbeddedToolAction =
  | 'event.sources.list'
  | 'trigger.create'
  | 'trigger.list'
  | 'trigger.inspect'
  | 'trigger.pause'
  | 'trigger.resume'
  | 'trigger.delete'
  | 'trigger.update';

export interface EventIntelligenceAgentToolsOptions<RuntimeContext = unknown> {
  host: EventIntelligenceHost;
  resolveContext(
    runtimeContext: RuntimeContext,
    request: {
      action: EmbeddedToolAction;
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
  control(input: {
    capability: EventIntelligenceCapabilityMetadata;
    action:
      | 'trigger.create'
      | 'trigger.pause'
      | 'trigger.resume'
      | 'trigger.delete'
      | 'trigger.update';
    runtimeContext: RuntimeContext;
    context: EmbeddedToolContext;
    input: unknown;
    plan?: any;
    resource?: unknown;
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
   * Optional host-owned projection for canonical EI failures. Returning null
   * keeps the canonical error; projection failures also fall back to it.
   */
  projectError?(input: {
    capability: EventIntelligenceCapabilityMetadata;
    runtimeContext: RuntimeContext;
    context?: EmbeddedToolContext;
    phase: string;
    error?: PortableToolResult['error'];
    result: PortableToolResult;
  }): PortableToolResult | void | Promise<PortableToolResult | void>;

  names?: {
    sources?: string;
    create?: string;
    list?: string;
    inspect?: string;
    pause?: string;
    resume?: string;
    delete?: string;
    update?: string;
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
  projectError?: EventIntelligenceAgentToolsOptions<RuntimeContext>['projectError'];
  names?: {
    sources?: string;
    create?: string;
    list?: string;
    inspect?: string;
    pause?: string;
    resume?: string;
    delete?: string;
    update?: string;
  };
}

export interface EmbeddedRuntimeIntegrationOptions<RuntimeContext = unknown>
  extends Omit<
    EmbeddedEventIntelligenceOptions<RuntimeContext>,
    'mcpRegistry' | 'mcp' | 'agentTools'
  > {
  eventSources?:
    | EventSourceRegistry
    | EventSourceRegistryOptions
    | Iterable<EventSourceConnection>;
  tooling?: EmbeddedRuntimeTooling<RuntimeContext>;
}

export interface EmbeddedRuntimeIntegration<RuntimeContext = unknown>
  extends Omit<EmbeddedEventIntelligence<RuntimeContext>, 'tools'> {
  /** Present only when the canonical facade negotiated hostContract v1. */
  readonly hostContract?: HostContractNegotiationV1;
  readonly tools: readonly PortableAgentTool<RuntimeContext>[];
  readonly toolCatalog: PortableToolCatalog<RuntimeContext>;
  readonly capabilities: readonly EventIntelligenceCapabilityMetadata[];
  readonly eventSources: EventSourceRegistry | null;
  diagnostics(): Promise<EventSourceDiagnostics>;
  bind<HostTool>(
    options: EmbeddedRuntimeBindOptions<RuntimeContext, HostTool>,
  ): readonly HostTool[];
}

export function createDeterministicReceiptId(
  namespace: string,
  wakeId: string,
  options?: { length?: number },
): string;

export function summarizeEventSourceStatus(
  statuses?: readonly any[],
  refreshOutcomes?: readonly any[],
): EventSourceDiagnostics;

export function bindEmbeddedRuntimeIntegration<
  RuntimeContext = unknown,
  HostTool = unknown,
>(
  integration: Pick<
    EmbeddedRuntimeIntegration<RuntimeContext>,
    'tools' | 'close'
  >,
  options: EmbeddedRuntimeBindOptions<RuntimeContext, HostTool>,
): readonly HostTool[];

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

/**
 * Common host-neutral bindings. EI consumes host capabilities without owning
 * MCP sessions, policy/approval decisions or continuation execution.
 */
export interface EventIntelligenceRuntimeBindings<
  RuntimeContext = unknown,
  Target = RuntimeTarget,
>
  extends Pick<
    ActivationDispatcherOptions<Target>,
    'deliver' | 'resolveTarget' | 'hasReceipt' | 'receiptId' | 'receiptNamespace'
  > {
  resolveContext?: EmbeddedRuntimeTooling<RuntimeContext>['resolveContext'];
  control?: EmbeddedRuntimeTooling<RuntimeContext>['control'];
  projectResult?: EmbeddedRuntimeTooling<RuntimeContext>['projectResult'];
  projectError?: EmbeddedRuntimeTooling<RuntimeContext>['projectError'];
  /** Host-owned model tool names (e.g. event_watch_create), never permissions. */
  names?: EmbeddedRuntimeTooling<RuntimeContext>['names'];
}

/**
 * Simplified embedded entry point. Agent-facing tools are available only when
 * both runtime.resolveContext and runtime.control are supplied.
 */
/** Version 1 of the explicit, host-owned embedded capability handshake. */
export type HostContractCapability =
  | 'mcp.registry'
  | 'storage.durable'
  | 'storage.shared'
  | 'wake.receipts'
  | 'tooling.owner-scoped'
  | 'semantic.evaluate'
  | 'observability.sink';

export interface HostContractV1 {
  version: '1';
  /** Unsupported/absent capabilities reject before host startup. */
  required: readonly HostContractCapability[];
}

export interface HostContractNegotiationV1 {
  readonly schema: 'event-intelligence.host-contract.v1';
  readonly version: '1';
  readonly required: readonly HostContractCapability[];
  /** Configuration presence only, NOT authorization or actual durability. */
  readonly available: Readonly<Record<HostContractCapability, boolean>>;
  readonly readiness: 'configuration-validated';
}

export const HOST_CONTRACT_VERSION: '1';
export const HOST_CONTRACT_CAPABILITIES: readonly HostContractCapability[];

export function negotiateHostContract(
  contract: HostContractV1,
  options?: {
    mcp?: EventSourceRegistryOptions;
    runtime?: EventIntelligenceRuntimeBindings;
    store?: EventIntelligenceHostOptions['store'];
    dataDir?: string;
    env?: Record<string, string | undefined>;
    semanticEvaluator?: unknown;
    observability?: EventIntelligenceHostOptions['observability'];
  },
): HostContractNegotiationV1;

export interface EventIntelligenceOptions<
  RuntimeContext = unknown,
  Target = RuntimeTarget,
>
  extends Omit<
    EmbeddedRuntimeIntegrationOptions<RuntimeContext>,
    'eventSources' | 'activation' | 'wake' | 'tooling'
  > {
  mcp?: EventSourceRegistryOptions;
  runtime: EventIntelligenceRuntimeBindings<RuntimeContext, Target>;
  /** Opt-in pre-v1; no callback/credential/policy ownership transfers to EI. */
  hostContract?: HostContractV1;
}

export function createEventIntelligence<
  RuntimeContext = unknown,
  Target = RuntimeTarget,
>(
  options: EventIntelligenceOptions<RuntimeContext, Target>,
): Promise<EmbeddedRuntimeIntegration<RuntimeContext>>;

export type EmbeddedOperationKey =
  | 'sources' | 'create' | 'list' | 'inspect'
  | 'pause' | 'resume' | 'delete' | 'update';

/** Canonical portable embedded operation metadata (MCP stdio parity is separate). */
export const EMBEDDED_OPERATION_REGISTRY: Readonly<
  Record<
    EmbeddedOperationKey,
    Readonly<{
      name: string;
      capability: EventIntelligenceCapabilityMetadata;
      inputSchema: Record<string, unknown>;
    }>
  >
>;

import type {
  TriggerPlanInput,
} from '../dist/src/intelligenceProtocol/index.js';

/**
 * One-event authoring shortcut. Output is the canonical TriggerPlanInput;
 * the host still validates source availability, scope and mutation control.
 */
export interface SimpleTriggerPlanInput
  extends Partial<Pick<
    TriggerPlanInput,
    'triggerId' | 'version' | 'description' | 'withinMs' |
    'eventTime' | 'lifecycle'
  >> {
  when: {
    id?: string;
    event: string;
    serverId?: string;
    arguments?: Record<string, unknown>;
    where?: TriggerPlanInput['events'][number]['where'];
  };
  then: {
    target: NonNullable<TriggerPlanInput['target']>;
    instruction: string;
    contextPolicy?: Partial<NonNullable<TriggerPlanInput['continuation']>['contextPolicy']>;
  };
}

/**
 * Optional compile-time checked form for the existing toTriggerPlan() function.
 *
 * Supply Payload from the provider SDK's exported type, z.infer<typeof schema>,
 * or a TypeScript shape independently verified against an MCP payloadSchema.
 * Only top-level string-keyed fields are statically checked; canonical
 * TriggerPlanner remains authoritative for source availability, nested paths,
 * advertised JSON schemas and runtime values.
 *
 * This is TYPE-ONLY: there is no additional DSL, parser or evaluator.
 */
type TypedSourceKey<Payload extends object> =
  Extract<keyof Payload, string>;

type TypedSourceScalar<Value> =
  Extract<NonNullable<Value>, string | number | boolean>;

// The existing matcher supports string substring and scalar array membership,
// but never "contains" on standalone numbers or booleans.
type TypedSourceArrayElement<Value> =
  Value extends readonly (infer Element)[]
    ? Extract<Element, string | number | boolean>
    : never;

type TypedSourceContained<Value> =
  // Runtime uses String(predicate.value) before substring matching,
  // including numeric and boolean scalar operands for literal/enum strings.
  (Extract<NonNullable<Value>, string> extends never
    ? never : string | number | boolean) |
  // Array.prototype.includes() compares complete elements, so do NOT widen
  // literal array element types to arbitrary strings.
  TypedSourceArrayElement<NonNullable<Value>>;

type TypedSourcePredicateAt<
  Payload extends object,
  Key extends TypedSourceKey<Payload>,
> =
  // Allowed even for non-scalar values: metadata/existence assertions.
  | { path: Key; op: 'exists' | 'isNull'; value?: boolean }
  | { path: Key; op: 'type'; value: 'string' | 'number' | 'boolean' |
      'null' | 'object' | 'array' }
  | (TypedSourceScalar<Payload[Key]> extends never ? never :
      { path: Key; op: 'eq' | 'neq';
        value: TypedSourceScalar<Payload[Key]> })
  | (TypedSourceContained<Payload[Key]> extends never ? never :
      { path: Key; op: 'contains';
        value: TypedSourceContained<Payload[Key]> })
  | (TypedSourceScalar<Payload[Key]> extends never ? never :
      { path: Key; op: 'in' | 'notIn';
        value: TypedSourceScalar<Payload[Key]>[] })
  | (Extract<NonNullable<Payload[Key]>, number> extends never ? never :
      { path: Key; op: 'between'; value: [number, number] })
  | (Extract<NonNullable<Payload[Key]>, string> extends never ? never :
      { path: Key; op: 'between'; value: [string, string] })
  | (Extract<NonNullable<Payload[Key]>, number> extends never ? never :
      { path: Key; op: 'gt' | 'gte' | 'lt' | 'lte';
        value: number })
  | (Extract<NonNullable<Payload[Key]>, string> extends never ? never :
      { path: Key; op: 'startsWith' | 'endsWith';
        value: string } |
      { path: Key; op: 'regex'; value: string; flags?: string });

// Distribute over every union member before computing keys: a provider's
// discriminated event union may have variant-only fields that are valid on
// just one payload shape. The runtime schema/planner still handles missing
// fields when a different variant arrives.
export type TypedSourcePredicate<Payload extends object> =
  Payload extends unknown
    ? {
        [Key in TypedSourceKey<Payload>]: TypedSourcePredicateAt<Payload, Key>;
      }[TypedSourceKey<Payload>]
    : never;

export type TypedSimpleTriggerPlanInput<Payload extends object> =
  Omit<SimpleTriggerPlanInput, 'when'> & {
    when: Omit<SimpleTriggerPlanInput['when'], 'where'> & {
      where?: TypedSourcePredicate<Payload>[];
    };
  };

/** Unannotated callers retain the existing canonical untyped surface. */
export function toTriggerPlan(options: SimpleTriggerPlanInput): TriggerPlanInput;
/**
 * Explicit Payload binds predicate paths and scalar/operator types.
 * For example: toTriggerPlan<z.infer<typeof payloadSchema>>({...}).
 * This overload delegates to exactly the same runtime function.
 */
export function toTriggerPlan<Payload extends object>(
  options: TypedSimpleTriggerPlanInput<Payload>,
): TriggerPlanInput;

export const EVENT_INTELLIGENCE_CAPABILITIES: Readonly<{
  eventSourcesList: Readonly<EventIntelligenceCapabilityMetadata>;
  triggerCreate: Readonly<EventIntelligenceCapabilityMetadata>;
  triggerList: Readonly<EventIntelligenceCapabilityMetadata>;
  triggerInspect: Readonly<EventIntelligenceCapabilityMetadata>;
  triggerPause: Readonly<EventIntelligenceCapabilityMetadata>;
  triggerResume: Readonly<EventIntelligenceCapabilityMetadata>;
  triggerDelete: Readonly<EventIntelligenceCapabilityMetadata>;
  triggerUpdate: Readonly<EventIntelligenceCapabilityMetadata>;
}>;

export const PORTABLE_EVENT_INTELLIGENCE_TOOL_NAMES: Readonly<{
  sources: 'event_sources_list';
  create: 'trigger_create';
  list: 'trigger_list';
  inspect: 'trigger_inspect';
  pause: 'trigger_pause';
  resume: 'trigger_resume';
  delete: 'trigger_delete';
  update: 'trigger_update';
}>;