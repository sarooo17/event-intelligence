# Quickstart

The primary v0.1 integration is to embed Event Intelligence once at the **harness level** and let it discover the MCP clients that harness already owns.

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
  wake: async (packet) => {
    const receipt = await harness.resume(packet.target, packet);
    return { runtimeReceiptId: receipt.id };
  },
});
```

That is the only MCP integration point. If the harness has 5, 50 or 1,000 MCP connections, EI enumerates the registry itself. It attaches Events-capable connections, ignores tools-only connections, and can refresh automatically when the registry changes.

The host keeps transports, OAuth/API keys and ordinary tool calls. EI never needs the provider credentials.

## 2. Create a trigger

Once sources have been discovered, create a structured trigger through `triggerControl`:

```js
await ei.triggerControl.createTrigger({
  definition: {
    triggerId: 'release-ready',
    version: '1',
    clauses: [
      {
        id: 'pr',
        event: 'pr.merged',
        serverId: 'github-mcp',
        where: [],
      },
    ],
    expression: { kind: 'anyOf', refs: ['pr'] },
    withinMs: 60 * 60 * 1000,
    target: {
      runtime: 'agent',
      kind: 'task',
      id: 'release-review',
    },
  },
  connectionIds: ['github'],
  actor: { type: 'user', principal_id: 'user-1' },
  owner: { type: 'user', principal_id: 'user-1' },
});
```

When `pr.merged` arrives, the harness-level `wake` dispatcher is invoked with the trigger target, so it can resume the correct task/session/agent. The agent does not need to remain alive while waiting.

## 3. Let the existing agent author the trigger

No second LLM is needed. The agent already running in the harness can:

1. inspect EI's discovered event sources and payload schemas;
2. construct the structured trigger definition;
3. call the governed trigger-create surface.

The control plane validates the trigger schema, source scope, referenced predicate/correlation fields and derived-event projections before persistence. Agent-authored persistent mutations still require the host's confirmation policy.

## 4. Semantic correlation is optional

No TypeSafe/Jev key is required for deterministic Event Intelligence behavior.

`TYPESAFE_API_KEY` only enables the bundled Jev evaluator for triggers that explicitly use semantic correlation. Hosts may inject their own `semanticEvaluator`.

There is no OpenAI dependency in EI. The surrounding agent/harness does the reasoning; EI owns durable event semantics.

## 5. Optional MCP stdio control plane

The same package can expose Event Intelligence management tools as a standard MCP server:

```text
command: npx
args:    -y mcp-event-intelligence mcp
```

The default surface is non-mutating and includes:

```text
event_sources_list
trigger_list
trigger_inspect
trigger_simulate
derived_contracts_list
runtime_status
```

With writes enabled, the existing agent can author a structured trigger and call `trigger_create`; EI does not invoke another model to reinterpret the request.

Persistent mutations are only exposed with:

```bash
MCP_WRITE_ENABLED=true
```

and each mutation requires a `confirmationId`.

This MCP server is an optional **control-plane adapter**. It does not own or duplicate the host's provider MCP connections.

## 6. Standalone reference service

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
