# Minimal runtime-neutral embedded integration

`createEventIntelligence()` is a small host-neutral composition layer around the existing embedded engine. It does **not** create MCP connections, model loops, credentials, permissions, database instances, or a second event interpreter.

> This API is proposed in PR #52 (or its final PR number). Use a published version containing this export; `mcp-event-intelligence@0.11.0` does not expose it.

## Integration with an existing host

```js
import { createEventIntelligence } from 'mcp-event-intelligence/embedded';

const integration = await createEventIntelligence({
  mcp: {
    list: () => host.mcp.listConnectedEventsClients(),
    subscribe: (onChange) => host.mcp.onConnectionsChanged(onChange),
  },
  runtime: {
    receiptNamespace: 'my-host',
    // Host-level durable receipt lookup. EI does not own Turn/Job state.
    hasReceipt: (receiptId) => host.turns.hasReceipt(receiptId),
    resolveTarget: (target) => host.turns.resolveTarget(target),
    deliver: ({ activation, target, receiptId }) =>
      host.turns.resumeFromEvent({ activation, target, receiptId }),

    // Optional, but BOTH methods are required if EI exposes model tools:
    resolveContext: (ctx) => host.eiContext(ctx),
    control: (request) => host.policy.control(request),
  },
  store: host.eiStore,
});

const tools = integration.toolCatalog.list({
  capabilityIds: await host.policy.eventIntelligenceCapabilities(),
});
for (const tool of tools) {
  host.tools.register(host.toNativeTool(tool));
}

host.onShutdown(() => integration.close());
```

The resulting `toolCatalog` and callbacks remain host-owned: translating and exposing EI tools does not bypass host authorization. The host must enforce visibility at discovery **and** execution.

### Headless host

Without `resolveContext` and `control`, the integration has **no model-facing tools** but still supports event matching and delivery to an opaque host continuation:

```js
const ei = await createEventIntelligence({
  runtime: {
    deliver: ({ activation, target, receiptId }) =>
      workflow.resume(target, { activation, receiptId }),
  },
  store: workflow.eiStore,
});
```

### Contract and limits

- `runtime.deliver()` is mandatory; the host must own and secure continuation delivery.
- `runtime.resolveContext()` and `runtime.control()` must be supplied **together** to expose trigger tools. Missing mutation control fails **before** the host is initialized. Returning `{action:'return',result}` preserves host authorization, interrupt and approval behavior.
- `runtime.hasReceipt()`, `resolveTarget()`, `receiptId()` or `receiptNamespace` are passed through to the existing activation dispatcher. `receiptId` and `receiptNamespace` cannot both be supplied.
- `mcp.list()` returns host-owned already-connected MCP Events clients. `mcp.subscribe()` is optional. No provider credentials are copied into EI.
- `store`, `env`, `semanticEvaluator`, `observability`, and optional advanced parameters are passed to the existing embedded runtime.
- The lower-level `createEmbeddedRuntimeIntegration()` remains useful for advanced custom wiring; it is not a vendor-compatibility shim.
- The host remains responsible for idempotent receipt persistence, scope/tenant access, wake retries at its boundary and lifecycle integration. Only claim exactly-once logical activation for paths whose host receipts prove it.
- This API does not promise automatic compatibility with an arbitrary private runtime; the runtime must implement the neutral contract.

## Verification

Run the embedded integration suite:

```bash
npm run build
node --test test/embedded-host-kit.test.mjs
```

Tests check that the facade uses the same engine/portable catalog and delegates wake, host policy and control without creating its own authority path. This is the first integration ergonomics slice; full independent-host clean-room conformance remains tracked under [#42](https://github.com/sarooo17/event-intelligence/issues/42).

### Fail-fast configuration diagnostics

The neutral `createEventIntelligence()` entry point raises `TypeError` before
creating a host when mandatory callbacks or mutually exclusive receipt settings
are invalid. Integrators can use `error.code` rather than matching English
messages. These are **configuration** errors, not event-processing failures:

| Code | Meaning |
| --- | --- |
| `EI_HOST_DELIVERY_REQUIRED` | Missing or noncallable `runtime.deliver()` |
| `EI_HOST_MCP_REGISTRY_INVALID` | `mcp.list()` missing, or `subscribe` not callable |
| `EI_HOST_CONTROL_REQUIRED` | Only one of `resolveContext()` and `control()` supplied |
| `EI_HOST_CALLBACK_INVALID` | Invalid optional runtime callback |
| `EI_HOST_RECEIPT_CONFIG_INVALID` | Blank namespace or conflicting receipt strategies |

The host still owns identity resolution, approval/policy, receipts, and data
storage. A valid shape does not mean the host was authorized or that a
connection is healthy; runtime failures keep their existing codes.
These diagnostics add no historical compatibility adapter.

Run the focused probes with `node --test test/host-configuration-errors.test.mjs`
after `npm run build`.

## Lifecycle ownership: failure-atomic setup (issue #42)

The embedded host is started only after the normal configuration checks. Once
`createHost()` has succeeded, EI requires a callable `host.close()` (stable
`EI_HOST_LIFECYCLE_INVALID` failure otherwise). Both
`createEmbeddedEventIntelligence()` and `createEmbeddedRuntimeIntegration()`
release that host if construction of a model-facing tool catalog fails after
host startup, while propagating the original configuration failure rather
than masking it with any cleanup error.

`integration.close()` returns the same promise on overlapping, repeated, or
post-settlement calls. This means hosts can safely connect multiple shutdown
hooks via `integration.bind({ onClose })` and also call `close()` explicitly
without double-closing storage, timers or MCP subscriptions. If closing fails,
subsequent calls observe the same rejection; EI does not silently retry an
ambiguous partial shutdown.

The host still owns process signals, shutdown hook invocation, MCP network
sessions, policy and continuation side effects. This contract only covers
host resources returned successfully by `createHost()`; it cannot magically
recover resources a failing host factory never returned. Tests in
`test/embedded-lifecycle-ownership.test.mjs` cover failed setup, cleanup
errors and overlapping host/app shutdown hooks with no external runtime SDK.
This is **partial #42 acceptance**, not yet third-party independent
integration or complete three-host lifecycle v3 certification.

### MCP registry shutdown fence

`createEventIntelligenceHost()` now treats registry initialization as part of
host startup. If the initial discovery or `mcpRegistry.subscribe()` fails
after the runtime and its store were started, startup rejects **after**
closing the initialized runtime; cleanup failures never mask the original
startup failure.

`host.close()` immediately fences new registry refresh requests, late
registry subscription notifications, and manual connection attachments.
An already-running registry discovery is drained before runtime shutdown;
if it resolves after the close fence its entries are discarded. Repeated
`close()` calls share the same promise and invoke registry unsubscribe once.
Calls to `refreshMcpRegistry()` / `attachMcpClient()` during shutdown fail
with stable `EI_HOST_CLOSED`. Host-owned MCP sessions and credentials remain
outside EI's authority; the host is still responsible for invoking shutdown
and unsubscribing any connections it owns.

The real-host tests in `test/host-registry-shutdown-contract.test.mjs`
check failed startup cleanup, late observer callbacks and an in-flight
asynchronous registry enumeration resolved during host shutdown. This is a
focused #42 lifecycle slice, not independent third-party conformance.
