---
name: event-intelligence-integration
description: Integrate the pre-v1 Event Intelligence SDK into any existing AI agent, workflow host, or MCP-enabled runtime. Use when implementing durable event-triggered wakeups without polling the LLM, connecting existing host MCP clients, designing tenant/receipt boundaries, or testing EI conformance.
---

# Integrate Event Intelligence into an existing agent host

This skill provides **procedural integration guidance**, not an installed
plugin or permission to mutate a user's application. Read the target repo
first, then use its actual runtime/identity/storage APIs. Full reference:
[AI agent integration guide](../../../docs/AI-AGENT-INTEGRATION.md).

## Detect before writing

1. Determine whether the user wants **embedded EI**, the **MCP stdio
   control plane**, or only an architecture assessment. Do not start a new
   service when embedded mode is requested.
2. Inspect the host's MCP connection registry, scope/tenant/owner model,
   continuation/resume entry point, durable receipt store, shutdown lifecycle
   and durable storage topology.
3. Check the **installed package version** and `package.json.exports`.
   `0.12.0-next.1` is the documented pre-v1 `next` preview; plain
   `npm install mcp-event-intelligence` follows npm `latest`, which may
   be different. Do not silently update an existing pin.
4. Read the version-specific [migration matrix](../../../docs/releases/0.12.0-next.1-compatibility.md)
   before modifying state or existing trigger contracts.

## Preferred path: host-neutral embedded EI

Use the public `mcp-event-intelligence/embedded` export:

```js
import { createEventIntelligence } from 'mcp-event-intelligence/embedded';

const integration = await createEventIntelligence({
  dataDir: './data/event-intelligence', // single-process reference only
  mcp: {
    list: () => host.mcp.listConnections(), // already-open host-owned clients
    subscribe: (refresh) => host.mcp.onConnectionsChanged(refresh),
  },
  runtime: {
    receiptNamespace: 'my-host', // stable across restarts
    hasReceipt: (id) => host.receipts.hasPersisted(id),
    deliver: async ({ activation, target, receiptId }) => {
      const receipt = await host.resumeIdempotently({
        target, activation, receiptId,
      });
      // Return only after durable host acknowledgement.
      return { runtimeReceiptId: receipt.id };
    },
  },
});

// Close on host shutdown: await integration.close();
```

The `host.*` methods above are **integration placeholders**, not APIs
provided by EI. Replace with real target-runtime methods, confirm the
receipt is durable across restart and restrict a multiworker deployment to
a validated shared storage implementation.

- To make EI **model-facing**, also provide BOTH
  `runtime.resolveContext()` and `runtime.control()`. The host owns
  actor/owner identity, authorization and human approval. An untrusted
  tool cannot decide its own authority.
- The lower-level `createEventIntelligenceHost()` and
  `createEmbeddedRuntimeIntegration()` are supported alternatives;
  use one boundary, not multiple overlapping EI runtimes.
- Never reconnect MCP transports or copy provider OAuth credentials
  into EI merely to discover Events-capable connections.

## Trigger creation and model tool flow

Use `integration.host.planTrigger(input)` or the model-facing
`trigger_plan` to resolve real source/event schemas; persist with scoped
`triggerControl.createTrigger({ definition: plan.definition,
connectionIds: plan.connectionIds, actor, owner })` after host policy.
Describe only supported sources. Advanced logic uses **Pattern AST v2**,
not a new prompt-generated DSL.

Two **different** model/control surfaces:

- **Embedded facade** `createEventIntelligence()`: the exported
  `toolCatalog` has `event_sources_list`, `trigger_create` and
  lifecycle tools; **it does NOT expose** `trigger_plan` or
  `trigger_language_describe` as portable tools. Embedded
  `trigger_create` can compile an agent-friendly plan internally;
  alternatively use `integration.host.scope(scopeId).planTrigger(input)`
  from trusted host code and persist it with host-owned control.
- **MCP stdio control plane** only: `event_sources_list` →
  `trigger_language_describe` (when needed) → `trigger_plan` →
  host-confirmed `trigger_create`. These tool names must not be
  assumed available on the embedded `toolCatalog`.

## Verify and report

- Run focused functional tests (source event → durable match → wake →
  host receipt → restart/replay), including negative tests for duplicate
  wake, stale owner/session, cross-tenant delivery and unknown provider
  source completeness.
- For a conformance adapter use
  `runHostConformance(adapter, { throwOnFailure: true })`
  from `mcp-event-intelligence/conformance`; see
  [the exact v3 adapter contract](../../../conformance/README.md).
- If modifying EI itself: `npm ci`, `npm run check`,
  `npm run pack:check`.
- Output: files changed, install version, explicit host responsibilities,
  checks actually run, unsupported provider operations and unresolved
  deployment risks. Do not claim production HA/SLO, model-independent
  security signoff or stable-v1 certification from a passing smoke test.
