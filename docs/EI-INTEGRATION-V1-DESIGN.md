# Proposed v1 embedded integration design

> Design proposal for [#42](https://github.com/sarooo17/event-intelligence/issues/42), [#43](https://github.com/sarooo17/event-intelligence/issues/43), [#46](https://github.com/sarooo17/event-intelligence/issues/46). **Not implemented.** The current released API is `createEmbeddedRuntimeIntegration()`.

## User goal

An agent-runtime engineer wants to add **durable future-condition monitoring** to a host already managing MCP connections, users, tool exposure, approvals and durable agent work. They should not need to understand every CEP primitive or create a duplicate transport, scheduler, model loop or storage control plane.

The integration must work for:
- a single-process local CLI coding assistant;
- a multi-tenant web/backend agent;
- a headless workflow host with no model/tool surface;
- a runtime with structured interrupts/approvals and opaque continuation targets.

The integration must not assume ChatGPT, Cursor, Claude, Codex, Muffin, Artemis or any particular agent SDK.

## Current public surface (v0.11)

`createEmbeddedRuntimeIntegration({ eventSources, activation, tooling?, store?, ... })` already returns a host, portable tool catalog, `bind()`, diagnostics and lifecycle methods. The source registry discovers already-connected MCP Events sessions. `activation.deliver()` routes matched evidence to the host. An optional `tooling.control()` delegates any durable create/update/pause/resume/delete action to host policy, including host-owned approvals/interrupts.

**Pre-1.0 design decision:** this is the *current* API, not a permanent compatibility constraint. Prefer one clean canonical public API; refactor or remove old exports if maintaining both would create duplicate paths. Document breaking changes instead of shipping compatibility shims for existing hosts.

## Proposed canonical façade (illustrative pseudocode; NOT executable)

```ts
import { createEventIntelligence } from 'mcp-event-intelligence/embedded';

const integration = await createEventIntelligence({
  mcp: {
    list: () => host.mcp.listConnections(),
    subscribe: refresh => host.mcp.onConnectionsChanged(refresh),
  },
  runtime: {
    context: ctx => host.getEventContext(ctx), // owner, actor, scope, target
    control: request => host.policy.control(request),
    deliver: ({ target, activation, receiptId }) =>
      host.resumeFromEvent({ target, activation, receiptId }),
    hasReceipt: id => host.receipts.has(id),
  },
  storage: host.storage.ei,
  // optional tooling, telemetry and semantic evaluator
});
await integration.start();
```

This design targets minimal *generic* wiring. A production host still needs correct identity, principal authority, continuation semantics, idempotent receipts, underlying database and lifecycle ownership. A 10-line snippet must never imply those concerns disappear.

## Host capability handshake (proposed)

The handshake describes capabilities; it must never silently change auth/policy semantics.

| Capability | Mandatory when | Owner | Failure policy |
| --- | --- | --- | --- |
| MCP event-source registry | Any MCP Events source used | Host | No source: explicit inactive/readiness status; malformed registry: error |
| Continuation resolution + delivery | Trigger targets an agent/workflow | Host | Fail closed or durable retry; never invent target |
| Persisted wake receipt/idempotency | Durable target activation | Host and EI cooperate | Enforce documented idempotency policy; cannot claim once-only without receipt |
| Owner/scope identity | Agent-visible read/write tools and multi-tenant mode | Host | No identity -> deny scoped operation |
| Durable mutation approval/control | Creating/updating/deleting trigger from agent | Host | Missing control -> deny/fail closed |
| Durable store | Restart-safe triggers | Host supplies store/dir | Validate store capabilities; HA requires strong shared state |
| Semantic evaluator | Pattern includes semantic node | Host selects | Explicit disabled/unavailable result; structural CEP unaffected |
| Observability sink | Optional | Host | Best-effort; sink error nonblocking |

Profile negotiation should use capability IDs/version ranges and enable operations only when both sides explicitly support them. Never treat "callback absent" as unconditional allow, never expose a mutation capability that will fail kernel authorization or route through a fabricated default owner.

## Single operation registry

One canonical definition per EI operation holds:
- stable capability ID + version;
- input/output schemas;
- resource/effect/durability;
- host-control requirement, exposure constraints and identity/scope rules;
- canonical behavior version and documented breaking changes when public contracts change; no automatic pre-1.0 compatibility mapping.

Publish projections to embedded portable tools, CLI and standalone MCP control plane. Capabilities should be selectively discoverable under host policy. `trigger_plan` and simulation are not automatically visible merely because the package can perform them. The host remains responsible for principal-aware selection and execution.

Create **schema parity CI**, not two independently maintained copies of each tool shape.

## Simple authoring API (proposed)

```ts
// Does NOT exist in v0.11; compiles to the existing planTrigger() contract.
await integration.triggers.create({
  when: {
    event: 'github.pull_request.merged',
    where: { repository: 'example/api' },
  },
  then: {
    target: host.currentContinuation(),
    instruction: 'Review the release after the merge.',
  },
  lifecycle: { oneShot: true },
});
```

Design rules:
- Simple authoring performs deterministic schema-validated compilation into **canonical Pattern AST v2**; advanced callers can still supply the AST.
- The API cannot invent `serverId`, silently select an ambiguous source or bypass source/tenant authorization.
- Runtime-user creation always applies host control and persists approved ownership/confirmation provenance.
- Canonical plans, source arguments, match selection, time windows and error semantics are not reinterpreted by convenience sugar.
- In TypeScript, source payload types should be inferred when supplied as typed descriptors. Dynamic MCP schemas remain runtime-validated.
- Pinned, generated examples should compile against the packed npm release artifact.

## Lifecycle and error handling

The proposed canonical facade should coalesce registry refreshes, expose explicit `start()/close()/diagnostics()`, and optionally use host shutdown callbacks. No hidden worker or side-effectful startup when configuration is incomplete.

Introduce stable *category* codes for configuration errors (e.g. registry shape, missing scope identity, required mutation control, insufficient store capabilities, invalid receipt policy, unresolvable target). These are proposed categories; exact names are to be decided and semver-documented. No fabricated successful setup on partial attach errors.

Diagnostics must distinguish:
- connected but Events-unsupported MCP server;
- source currently unavailable/revoked;
- source available but no matching event descriptor;
- storage healthy/unhealthy and capability level;
- configured but unverified wake delivery;
- owner identity/approval not available for agent-facing mutation.

Never send synthetic delivery to a live conversation as part of an unauthorised "doctor" probe.

## Integration Doctor (proposed)

`mcp-event-intelligence doctor --json`:
- read-only validation of library version, Node runtime, source registry, MCP Events profile, event schemas, scope configuration, datastore capability declarations, receipt wiring and instrumentation configuration;
- warns when unable to attest true post-wake idempotency/host delivery;
- displays fixes and links to docs without exposing credentials, continuation instructions or raw event evidence;
- machine-readable PASS/WARN/FAIL + reason codes;
- never creates/deletes a real trigger, advances a cursor or emits an external wake during inspection.

## Testing and proof

1. **Clean-room host** implementing only documented neutral contract, no EI source edits.
2. **Headless host** with no exposed model tools.
3. **Tenant-aware host** with kernel-style owner/actor distinction and approval interrupt.
4. Real MCP Events client attach/detach/reconnect, source disabled/revoked, provider draft/profile mismatch.
5. Create/list/inspect/pause/resume/update/delete tests with read filter, scope and post-wake owner authority.
6. External event replay and host restart with persisted receipts, matching on the same canonical target.
7. `npm pack` install in isolated new project, Node 22+ and stated support matrix.
8. Negative tests: missing control, stale source, missing receipt, wrong scope, hostile payload/unknown target.

Measure time-to-first-trigger, code needed for generic wiring, confusing error rate, and new-host regressions. A 10/10 integration claim requires external adoption evidence, not just fewer lines in an internal test.

## Pre-1.0 evolution and migration

- Choose the **single clean canonical** public entry point for the next release. Legacy `createEmbeddedRuntimeIntegration()`, `createEventIntelligenceHost()` or other old exported paths may be removed if keeping them would duplicate behavior; preserve lower-level primitives only when they solve a distinct real use case.
- **No runtime-specific compatibility shims and no mandatory deprecation period before v1.0.** Document removed/renamed exports and new signatures in the changelog and migration notes; do not implement old behavior solely for Muffin or Artemis.
- Existing v0.11 consumers keep their exact pinned package until their owner explicitly upgrades. EI releases do not change host package manifests, lockfiles or deployments.
- Test the current public contract and fail closed on incompatibilities involving stored data or external MCP Events profiles. For persisted data, choose an intentional migration if warranted **or** a documented snapshot/reset/restore procedure; never silently wipe active triggers, receipts or scopes.
- Use [EI release compatibility](EI-RELEASE-COMPATIBILITY.md) to distinguish package API from provider/wire and persisted-state compatibility.

## Definition of done

Demonstrated minimal integration in three independent host shapes; no owner-policy regression; no per-runtime SDK adapter matrix; parity and conformance gates green on the packed release; documented unsupported host capabilities and meaningful failure modes.
