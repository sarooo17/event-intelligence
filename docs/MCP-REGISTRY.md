# MCP Registry

## v0.1 role

MCP Event Intelligence exposes an optional standard **MCP stdio control plane** through the official TypeScript SDK v2, targeting MCP protocol revision **2026-07-28**.

The primary runtime integration is the npm package entrypoint `mcp-event-intelligence/host`, where an agent host passes a registry for its already-connected MCP clients. The Registry server does **not** own provider MCP credentials or require those servers to be configured a second time.

Run the optional control plane with:

```bash
npx mcp-event-intelligence mcp
```

The stdio process exposes non-mutating tools by default:

```text
event_sources_list
trigger_list
trigger_inspect
trigger_simulate
derived_contracts_list
runtime_status
```

Persistent mutation tools are only registered when the operator explicitly sets:

```bash
MCP_WRITE_ENABLED=true
```

Even then, writes call the same `TriggerControlPlane`; each MCP mutation requires a non-empty `confirmationId` and cannot bypass event-source scope, owner checks, version checks or derived-contract validation.

## Registry identity

```text
io.github.sarooo17/event-intelligence
```

The npm package declares the same identity through `package.json#mcpName`.

`server.json` declares:

- npm package: `mcp-event-intelligence@0.1.0`;
- transport: `stdio`;
- positional package argument: `mcp`;
- only Event Intelligence control-plane/runtime settings, including optional Jev semantic-evaluator configuration.

It intentionally does **not** declare provider MCP connection configuration.

## Validation

CI installs the official `mcp-publisher` binary and runs:

```bash
mcp-publisher validate server.json
```

Actual Registry publication remains deferred until the sanitized public GitHub repository and npm artifact exist.

The Registry is a discovery/distribution channel for the optional control plane, not an integration hub for the host's other MCP servers.
