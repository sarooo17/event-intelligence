# Quickstart

The primary integration is to embed Event Intelligence once at the **harness level** and let it discover the MCP clients that harness already owns.

## 1. Embed the package and point it at the host registry

After publication:

```bash
npm install mcp-event-intelligence
```

```js
import {
  createEventIntelligenceHost,
  createMcpRegistryAdapter,
} from 'mcp-event-intelligence/host';

const ei = await createEventIntelligenceHost({
  dataDir: './data',
  mcpRegistry: createMcpRegistryAdapter({
    listConnections: () => harness.mcp.listConnections(),
    subscribe: (refresh) => harness.mcp.onConnectionsChanged(refresh),
  }),
  wake: async (packet, activation) => {
    const receipt = await harness.resume(packet.target, {
      packet,
      activation,
    });
    return { runtimeReceiptId: receipt.id };
  },
});
```

That is the only MCP integration point. If the harness has 5, 50 or 1,000 MCP connections, EI enumerates the registry itself. It attaches Events-capable connections, ignores tools-only connections, and can refresh automatically when the registry changes.

The host keeps transports, OAuth/API keys and ordinary tool calls. EI never needs the provider credentials.

## 2. Let the agent compile a trigger plan

For common agent-authored triggers, use the deterministic planner instead of asking
the model to produce the internal DSL directly:

```js
const plan = await ei.planTrigger({
  events: [{
    id: 'invoice',
    event: 'erpnext.sales_invoice.submitted',
    where: [
      { path: 'grand_total', op: 'gt', value: 10000 },
    ],
  }],
  match: 'all',
  withinMs: 60 * 60 * 1000,
  target: {
    runtime: 'agent',
    kind: 'conversation',
    id: 'chat-42',
  },
  continuation: {
    instruction:
      'Check the submitted invoice for anomalies and report back in this conversation.',
  },
});
```

The planner resolves the event against live discovered sources, fills the
`serverId`, validates predicate fields against the advertised payload schema,
compiles the expression and returns both the canonical definition and the
connection IDs needed by the control plane.

It does **not** call another model.

## 3. Persist the planned trigger

```js
await ei.triggerControl.createTrigger({
  definition: plan.definition,
  connectionIds: plan.connectionIds,
  actor: { type: 'user', principal_id: 'user-1' },
  owner: { type: 'user', principal_id: 'user-1' },
});
```

The same low-level `triggerControl.createTrigger` remains available for
advanced/fully structured definitions. The planner is a convenience boundary,
not a second execution model.

## 4. What happens when it fires

No second LLM is needed. The surrounding agent understands the user's intent;
EI compiles and validates the event program.

When the condition becomes true, the normal wire wake stays reference-only. In
embedded mode the host callback also receives a hydrated Activation Envelope:

```js
wake: async (packet, activation) => {
  console.log(activation.continuation.instruction);
  console.log(activation.evidence);

  const receipt = await agent.resume({
    target: activation.target,
    instruction: activation.continuation.instruction,
    context: activation.evidence,
  });

  return { runtimeReceiptId: receipt.id };
}
```

The envelope can also be reconstructed later with:

```js
const activation = ei.hydrateWake(packet.wake_id);
```

Matched event payloads in the envelope are explicitly marked as untrusted
external evidence. `continuation.contextPolicy` controls whether payload data
is included or only refs are returned.

## 5. Semantic correlation is optional

No TypeSafe/Jev key is required for deterministic Event Intelligence behavior.

`TYPESAFE_API_KEY` only enables the bundled Jev evaluator for triggers that explicitly use semantic correlation. Hosts may inject their own `semanticEvaluator`.

There is no OpenAI dependency in EI. The surrounding agent/harness does the reasoning; EI owns durable event semantics.

## 6. Optional MCP stdio control plane

The same package can expose Event Intelligence management tools as a standard MCP server:

```text
command: npx
args:    -y mcp-event-intelligence mcp
```

The default surface is non-mutating and includes:

```text
event_sources_list
trigger_plan
trigger_list
trigger_inspect
trigger_simulate
wake_hydrate
derived_contracts_list
runtime_status
```

With writes enabled, `trigger_create` accepts either a raw canonical `definition`
or an agent-friendly `plan`. In the latter case EI compiles the plan before
running the same source-scope, owner, version and confirmation checks.

Persistent mutations are only exposed with:

```bash
MCP_WRITE_ENABLED=true
```

and each mutation requires a `confirmationId`.

This MCP server is an optional **control-plane adapter**. It does not own or duplicate the host's provider MCP connections.

## 7. Standalone reference service

For protocol testing, provider-native adapters and manual event ingress:

```bash
npm ci
npm run build

export SERVICE_AUTH_TOKEN="$(openssl rand -hex 32)"
npm start
```

The service binds to port 3000 by default:

```bash
curl http://127.0.0.1:3000/readyz
```

The standalone service can register event sources through its authenticated HTTP control plane and can ingest provider-neutral events. Provider MCP connections remain owned by the embedding host rather than being configured inside the standalone service.

## Next: durable absence and composition

See [examples/release-gate.md](examples/release-gate.md) for a composed trigger with a durable time condition and runtime wake.
