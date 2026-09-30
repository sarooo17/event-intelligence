# MCP Registry

## Current role

MCP Event Intelligence exposes an optional standard **MCP stdio control plane** through the official TypeScript SDK v2, targeting MCP protocol revision **2026-07-28**.

The primary runtime integration is the npm package entrypoint `mcp-event-intelligence/host`, where an agent host passes a registry for its already-connected MCP clients. The Registry server does **not** own provider MCP credentials or require those servers to be configured twice.

Run the optional control plane with:

```bash
npx mcp-event-intelligence mcp
```

Read/non-mutating tools are exposed by default:

```text
event_sources_list
trigger_language_describe
trigger_plan
trigger_list
trigger_inspect
trigger_simulate
wake_hydrate
derived_contracts_list
runtime_status
```

`trigger_language_describe` exposes the Pattern grammar on demand. `trigger_plan` compiles agent-friendly input into the canonical Pattern trigger without calling a model. `wake_hydrate` reconstructs Activation Envelope v2.

Persistent mutation tools are registered only when:

```bash
MCP_WRITE_ENABLED=true
```

Each mutation still requires a non-empty `confirmationId` and passes through the same source-scope, owner, version and derived-contract validation as the embedded API.

## Registry identity

```text
io.github.sarooo17/event-intelligence
```

The npm package declares the same identity through `package.json#mcpName`.

`server.json` declares:

- npm package: `mcp-event-intelligence@0.6.0`;
- transport: `stdio`;
- positional package argument: `mcp`;
- only Event Intelligence control-plane/runtime settings, including optional Jev semantic-evaluator configuration.

It intentionally does **not** declare provider MCP connection configuration.

## Validation

CI validates `server.json` with the official MCP publisher tooling. Release automation publishes the npm package, registers the matching MCP Registry version and creates the corresponding GitHub Release.

The Registry is a discovery/distribution channel for the optional control plane, not an integration hub for the host's other MCP servers.
