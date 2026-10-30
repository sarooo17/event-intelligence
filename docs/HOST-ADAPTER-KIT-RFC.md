# Host Adapter Kit — composable, runtime-neutral integration RFC

Status: **proposal + tested existing boundary audit**, not a shipped Host Adapter Kit API.
Tracker: [#269](https://github.com/sarooo17/event-intelligence/issues/269);
implementation slices [#270](https://github.com/sarooo17/event-intelligence/issues/270),
[#271](https://github.com/sarooo17/event-intelligence/issues/271) and
[#272](https://github.com/sarooo17/event-intelligence/issues/272).
Related existing v1 HostContract/conformance work: [#42](https://github.com/sarooo17/event-intelligence/issues/42).
Current multi-agent/multi-organization integration-cost baseline and source-verified topology: [HOST-INTEGRATION-TOPOLOGY-COST.md](HOST-INTEGRATION-TOPOLOGY-COST.md), tracking [#352](https://github.com/sarooo17/event-intelligence/issues/352). The 391-LOC Muffin artifact is not a universal minimum or measured developer time.
Do not treat this RFC as acceptance for #42's independently authored external host.

## Goal and measured evidence

Make EI integration easier in *arbitrary* runtimes while preserving a single
CEP engine and a single canonical public embedded entry point. A headless
workflow server, coding agent, multi-agent graph, distributed work runner and
a tool-enabled application must all be valid consumers. Nothing may require a
chat, prompt, session, agent loop or particular model SDK.

Audited host consumer: `sarooo17/muffin-agent`, experiment
`experiment/ei-v1-single-path-adapter`,
`agent/event-intelligence.ts` at commit `2269ec20b6536342e99e03942d2b6c60a8c826f6`.
**392 physical / 361 nonblank lines**; original stable 0.11 consumer adapter
**398 physical / 365 nonblank lines**. This is the *complete* host file
including authorization, Turn/receipt work, taint and native tools. Neither
number is the size of the EI library.

| Complete host adapter region | Physical LOC | Existing EI primitive | Correct boundary |
| --- | ---: | --- | --- |
| Imports, native policy and host types, lines 1–66 | 66 | `EVENT_INTELLIGENCE_CAPABILITIES`, `HostContractV1` | Native policy declarations stay host-owned; typed EI descriptors generic |
| External evidence formatting, owner identity and in-process owner bindings, lines 67–124 | 58 | `ActivationEnvelope.trust`, `resolveContext` | Evidence/provenance portable; principal, scope, taint and caches host-owned |
| Occurrence envelope and wake-to-**Turn** delivery, lines 125–184 | 60 | `createActivationDispatcher` | Receipt semantics generic; queueing a Turn/graph/job host-owned |
| Tool naming, actor and mutation controls, lines 185–237 | 53 | `names`, `resolveContext`, `control` | Static presentation generic; actor/tenant policy host-owned |
| Native tool conversion, results and errors, lines 238–313 | 76 | `PortableAgentTool`, `PortableToolResult`, `bind`, `projectResult`, `projectError` | Most promising reusable data transformations; final ABI and trust enforcement host-owned |
| Callback composition and canonical facade creation, lines 314–354 | 41 | `createEventIntelligence` | Compose, do not fork the existing facade |
| Native runtime registration, close, diagnostics, lines 355–392 | 38 | `bindEmbeddedRuntimeIntegration`, `diagnostics`, `close` | Generic lifecycle cleanup; runtime hook host-owned |
| **Total** | **392** | | |

### API inventory: **reuse before inventing**

The current `mcp-event-intelligence/embedded` candidate already provides:

- `createEventIntelligence({ mcp, runtime, hostContract?, store?, ... })`, **one** neutral composition facade.
- `createEventSourceRegistry`, `createActivationDispatcher`, and `createDeterministicReceiptId`.
- `createPortableToolCatalog`, `bindEmbeddedRuntimeIntegration`, `PortableAgentTool`, `PortableToolResult`, `projectResult`, `projectError` and custom tool names.
- `EventIntelligenceRuntimeBindings<Context,Target>`, the canonical embedded operation manifest, `HostContractV1` and `runHostConformance` v3.
- Explicit lifecycle ownership, shared store capability validation and a headless **no-model-tools** mode.

**Decision:** do not duplicate these with new dispatchers, validation schemas,
durable receipt stores, authorization engines or a second `createEI()` entry.
The prospective kit should be an optional set of *pure composers/formatters*
above the existing facade, created only where the #270/#271 experiments prove
a meaningful reduction in repeated host-neutral glue.

## Design constraints and trust boundaries

| Concern | EI / optional kit may do | Must remain with host |
| --- | --- | --- |
| Source registry | Validate/list/subscribe already-open MCP Events connections | Own transport, auth, reconnect policy and credentials |
| Targets | Carry opaque `{runtime,kind,id}` references; resolve via callbacks | Authoritative target lookup, tenant/scope checks and real continuation semantics |
| Receipt | Derive deterministic candidate IDs; pre-check and retry reconciliation | Atomic, durable enqueue/upsert/receipt recording for external effects |
| Identity | Normalize *explicit host-supplied* data in EI's existing owner/actor shape | Resolve and authenticate principal, authorizations, revocation, tenancy |
| Tool metadata | Expose capability ID, effect, schemas and portable result metadata | Registration ABI, who discovers a tool and per-call policy/approvals |
| Result/evidence | Preserve typed shape, limit/document budgets and provenance | Define UI/prompt rendering, taint enforcement, secret redaction and storage |
| Lifecycle | Idempotent EI close and validated hooks | Host start/stop semantics, process supervision, cancellation |
| Persistent EI state | Use host-supplied store; validate EI store capabilities | Supply credentials, durability envelope, backups and deployment guarantees |
| Multi-agent/graph | Treat continuation keys as opaque targets | Graph traversal, agent/workflow routing and execution |

### Security invariants (non-negotiable)

1. **No invented owner.** A system-triggered wake is not owner speech. Actor,
   owner, scope and target must come from authoritative host state or an
   explicitly host-validated durable snapshot, never external event contents.
2. **Exposure is not authorization.** Capability allowlisting and tool naming
   cannot grant mutation authority. All mutations must go through host-owned
   `control()`, with structured host denial/interrupt semantics preserved.
3. **Untrusted evidence stays untrusted.** Structured provenance may be
   propagated; EI cannot mark a prompt safe or assume a host's trust/taint
   levels. No universal templated prompt renderer in the kit.
4. **Receipt precheck is NOT a transaction.** `hasReceipt()` before `deliver()`
   and reconciliation after failure help post-commit/pre-ack crashes. They do
   *not* serialize concurrent duplicate deliveries. Hosts requiring
   once-only side effects must atomically deduplicate the external enqueue
   using a durable, stable receipt ID.
5. **Memory is not authority.** Process-local LRU owner-to-Turn bindings are
   not a portable security mechanism; do not adopt them into the kit.
   Revocation and cross-worker replay must be checked using host state.
6. **Handshake presence != behavioral proof.** `readiness:
   'configuration-validated'` must never mean durable host receipts or
   independent host certification. Do not silently change this status.
7. **Fail closed on missing capability.** Tool-enabled hosts need both
   `resolveContext` and `control`; headless hosts need neither. No default
   `control:()=>execute`, cross-tenant wildcard or auto-registered tools.
8. **Version truth.** `main` exposes candidate changes while public npm
   0.11.0 may not; packed-package and declaration tests precede any claim of
   a released Host Adapter Kit. Consumer package/lockfile pins remain theirs.

## Proposed composable ports (illustrative, **not** currently exported)

```ts
// TS interface sketch, NOT a second runtime or an implemented API.
type HostPortConfig<Context, Target, NativeTool> = {
  sources?: {
    list(): Iterable<HostMcpConnectionOptions> | Promise<Iterable<HostMcpConnectionOptions>>;
    subscribe?(onChange: () => void): void | (() => void);
  };
  continuation: {
    deliver(input: ActivationDeliveryInput<Target>): Promise<HostWakeReceipt> | HostWakeReceipt;
    resolveTarget?: ActivationDispatcherOptions<Target>['resolveTarget'];
    hasReceipt?: ActivationDispatcherOptions<Target>['hasReceipt'];
    receiptNamespace?: string;
  };
  tooling?: {
    resolveContext: EventIntelligenceRuntimeBindings<Context, Target>['resolveContext'];
    control: EventIntelligenceRuntimeBindings<Context, Target>['control'];
    adapt: (portable: PortableAgentTool<Context>) => NativeTool;
    register: (native: NativeTool, portable: PortableAgentTool<Context>) => void;
    capabilityIds?: readonly string[];
  };
  lifecycle?: { onClose(close: () => Promise<void>): void };
};
// A future pure composer could only produce the already accepted
// { mcp?, runtime } shape for createEventIntelligence().
// Existing integration.bind({adapt,register,onClose,capabilityIds})
// remains the canonical tool installation mechanism.
```

Implement no `HostPortConfig` export until #270/#271 identify a gap it can
close **without** hiding host-specific code or creating duplicate entry points.
Build ports independently; do not force a host without model tools to provide
tool registration or auth hooks.

## Host-shape validation strategy

1. **Headless, no model/LLM tools:** opaque job/workflow continuation,
   `runtime.deliver` only; no tool list or made-up authorization defaults.
2. **Single-agent tool-enabled:** actor/scope resolved by host; approval/deny
   passthrough on all five mutations, allowlisted native registration and
   explicit trust metadata.
3. **Multi-target/multi-agent graph:** two unrelated continuation types,
   persisted host receipt, actor revocation and cross-tenant denial; concurrent
   delivery race and replay/restart assumptions documented.
4. Existing three **EI-maintained** v3 host shapes are useful regression
   inputs but do not constitute an independently authored third-party host.
   #42 retains that outstanding criterion; #272 adds a stronger independent
   integration artifact when an external author provides one.

Measure: independent author provenance, host shape, coverage matrix,
`physicalLines`/`nonblankLines` of full host adapters, total new kit LOC,
net combined code, package size, runtime overhead, optional dependencies,
CI status, latest-reviewed SHA and *unproved* guarantees. An adapter LOC win
alone is not evidence of lower engineering cost.

## Implementation order / exit gates

1. **#269 (this RFC):** audit, no-duplication decision, executable existing
   public boundary invariants. Docs-only design is not "kit complete".
2. **#270:** implement the smallest demonstrably reusable portable tool
   presentation helper, only if host-native mapping truly repeats across
   at least two differently-shaped hosts. Focused tests, TS exports and
   independent review before merging.
3. **#271:** encode only generic target/receipt/provenance checks not already
   present in `createActivationDispatcher`; test concurrent duplicate
   and restart/crash evidence, preserve host atomicity requirement.
4. **#272:** extend host-shape matrix without falsely declaring external
   authorship; pinned tarball and static type checks; report actual ROI.
5. Compare the **entire** adapter again in Muffin or another consumer on a
   separate, owner-controlled PR. No npm release, dependency pin change, or
   new canonical facade required by this RFC.

Each implementation PR requires exact-head CI and independent review.
The design may be rejected if existing primitives + docs solve the problem.
