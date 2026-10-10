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


### Embedded authority and optional MCP stdio output contracts (v1 preparation)

Event Intelligence's primary deployment is **embedded inside the host**. The
host owns MCP connections, OAuth/credentials, user identity, tool authorization,
interrupts/approvals, activation delivery and receipts. The bundled MCP stdio
tool surface is an **optional control-plane adapter**, not an additional Events
provider or a required separately running EI server.

The shared canonical operation manifest records each operation's name, scope,
effect and supported surfaces. Its model-facing input and output *projections*
can differ by surface without creating another CEP engine. On stdio the
read-only `trigger_inspect`, `trigger_simulate` and `wake_hydrate` now
advertise and validate their actual output Zod contracts, alongside the
previously modeled read operations. `wake_hydrate` reuses the canonical
`ActivationEnvelopeSchema`; the others verify the stable envelope and preserve
nested evidence. Owner checks and host policy are still enforced **before**
the output can be returned. An invalid result fails with
`EI_OUTPUT_CONTRACT_INVALID` rather than being silently projected.

This is not full #43 parity: embedded host-specific inspection projections
and mutating-operation output contracts remain separate work. In particular,
do not advertise a full inspection schema for an arbitrary host-supplied
inspector without validating that host's own contract.


### Durable mutation output contracts

The optional stdio adapter now advertises and validates the **five**
write-operation output projections (`trigger_create`, `trigger_update`,
`trigger_pause`, `trigger_resume`, `trigger_delete`) only when mutations
are explicitly enabled. Successful responses must include a non-empty
durable `receiptId`, the exact `action`, a canonical validated trigger
`definition`, and a lifecycle `state`. Update results must also include
the previous definition/state; create results may include a canonical
planner result. The validator does **not** coerce or strip a response and
does not grant mutation authority. Existing authorization, confirmation,
source scope and owner checks remain authoritative in the host/control
plane. Invalid success outputs fail closed with `EI_OUTPUT_CONTRACT_INVALID`.

The primary embedded facade intentionally returns **compact host-scoped**
results rather than these stdio-shaped receipts. Never apply the stdio
schema to the embedded adapter without an explicit canonical embedded
projection contract. This is a #43 implementation slice, not proof that
every host's supplied inspector or model-facing tool projections are
identical.
