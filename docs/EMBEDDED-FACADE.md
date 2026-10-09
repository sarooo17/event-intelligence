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
