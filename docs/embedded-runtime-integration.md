# Embedded runtime integration

Event Intelligence is embedded infrastructure, not a second agent runtime.

The package owns durable future conditions, event correlation, trigger lifecycle,
activation hydration and retryable wake delivery. The embedding host keeps
ownership of everything that is runtime-specific: credentials, policy,
authorization, approvals, interrupts, model/tool exposure, result storage,
continuation semantics and user-facing delivery.

## Invariants

1. **No named-runtime dispatch in EI core.**
   Adding a new runtime must not require a branch such as
   `if (runtime === "vendor-x")`.
2. **No adapter matrix in the package.**
   EI exports neutral contracts. A host translates them at its own boundary.
3. **MCP/Event connections stay host-owned.**
   EI receives references to already-open connections; it does not duplicate
   OAuth sessions, API keys or transport lifecycle.
4. **Continuation targets are opaque.**
   EI persists and returns `{ runtime, kind, id }` without deciding what a
   Turn, Execution, thread, checkpoint, workflow or Case means.
5. **Authorization and interrupt semantics are host-owned.**
   EI never reduces the host's control model to an `allowed: boolean`.
6. **Tool exposure is host-owned.**
   EI provides neutral tool descriptors and capability metadata; the host
   decides which descriptors are visible for a given principal/context.
7. **Large-result handling is host-owned.**
   EI can return an inline value or a host-defined result reference, but it does
   not become an artifact/blob/context store.

## High-level contract

```js
import {
  createDeterministicReceiptId,
  createEmbeddedRuntimeIntegration,
  createEventSourceRegistry,
} from 'mcp-event-intelligence/embedded';

const integration = await createEmbeddedRuntimeIntegration({
  eventSources: createEventSourceRegistry({
    list: () => host.eventConnections(),
    subscribe: (refresh) => host.onEventConnectionsChanged(refresh),
  }),

  activation: {
    receiptNamespace: 'my-runtime',
    resolveTarget: (target) => host.resolveContinuation(target),
    hasReceipt: (receiptId) => host.hasWakeReceipt(receiptId),
    deliver: ({ activation, target, receiptId }) =>
      host.resumeFromEvent({ activation, target, receiptId }),
  },

  tooling: {
    resolveContext: (ctx) => ({
      target: host.currentContinuation(ctx),
      actor: host.currentActor(ctx),
      owner: host.currentOwner(ctx),
    }),

    control: (request) => host.control(request),

    projectResult: (request) => host.projectResult(request),
  },
});
```

`tooling` is optional. A runtime that does not expose EI operations directly
to a model can omit it and still use the same source registry, trigger engine
and activation delivery contract.



## Reusable host glue

A host with a fixed set of already-open event connections can pass the iterable
directly instead of wrapping it:

```js
const integration = await createEmbeddedRuntimeIntegration({
  eventSources: host.eventConnections,
  // ...
});
```

Dynamic connection managers should keep using `createEventSourceRegistry()`
so they can expose `subscribe()`.

For runtimes that need a bounded deterministic execution/Turn/checkpoint id
from a wake, EI exposes a neutral hashing helper:

```js
const id = createDeterministicReceiptId('my-runtime', activation.wake.wakeId);
```

Or declare the namespace directly on the activation dispatcher with
`activation.receiptNamespace`; EI will derive the same id automatically.

The namespace is host-chosen. EI does not assign semantics to the resulting id.

`integration.diagnostics()` normalizes MCP-event source readiness into
`connections`, `eventsCapable`, `eventDefinitions`, `errors` and the
raw status rows. This keeps readiness counting out of every host without
prescribing how the host renders status.

Finally, `integration.bind()` removes the repetitive adaptation/registration
loop while leaving the actual host tool shape entirely host-owned:

```js
integration.bind({
  adapt: (portableTool) => host.toNativeTool(portableTool),
  register: (nativeTool, portableTool) =>
    host.register(nativeTool, host.mapCapability(portableTool.capability)),
  onClose: (close) => host.onClose(close),
});
```

This is deliberately callback-driven rather than a vendor adapter matrix.

## Host control

For a durable EI mutation, the host returns one of two neutral actions:

```ts
{ action: 'execute', execution?: { actor, owner, receiptId } }

{ action: 'return', result: PortableToolResult }
```

`action: "return"` is intentionally opaque to EI. The host may use it for
deny, human approval, interrupt, defer, quota, budget, tenant-policy or any
other control path. EI returns that result without interpreting the reason.

This is deliberately different from `authorize(): boolean`: a boolean cannot
represent a runtime that pauses for approval, materializes an interrupt, asks
for confirmation, or delegates control to another policy system.

## Capability metadata

Portable EI tools expose metadata such as:

```js
{
  id: 'event-intelligence.trigger.create',
  operation: 'create',
  resource: 'trigger',
  effect: 'durable-state',
  durability: 'durable',
  hostControl: 'required',
}
```

This metadata describes EI semantics only. It does **not** prescribe host risk
levels, RBAC roles, approval policy, reversibility vocabulary, tenant rules or
UI behavior. A host maps it into its own policy/capability system.

## Tool exposure

`toolCatalog` is a neutral catalog:

```js
integration.toolCatalog.all
integration.toolCatalog.get('trigger_create')
integration.toolCatalog.list({ capabilityIds: allowedCapabilityIds })
```

The catalog does not register tools with any SDK. The host performs the final
translation. There are intentionally no helpers such as `toOpenAI()`,
`toAnthropic()`, `toMuffin()` or `toArtemis()`.

## Result projection

A host may keep small results inline:

```js
projectResult: ({ value }) => ({ inline: value })
```

or externalize them:

```js
projectResult: async ({ value, capability }) => ({
  reference: {
    id: await host.results.put(value),
    kind: 'host-result',
    metadata: { capabilityId: capability.id },
  },
  summary: 'Result stored by the host',
})
```

EI validates the reference shape but does not read it back or own its storage.

## Event source registry

`createEventSourceRegistry()` abstracts the host's event-connection registry,
not the event protocol itself. Event Intelligence remains MCP Events-native,
while the registry avoids coupling source discovery to a particular agent
runtime's connection manager.

That distinction is intentional:

```text
runtime-specific connection manager
            │
            ▼
  EventSourceRegistry contract
            │
            ▼
      MCP Events ingestion
            │
            ▼
       Event Intelligence
```

A different runtime can therefore reuse the same EI package without EI knowing
anything about that runtime's session, model, UI, Work graph or capability
system.
