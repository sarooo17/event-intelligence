# Architecture

## Position in the stack

Event Intelligence is designed to run **inside the agent host**, next to the host's existing MCP client registry.

```text
                         Agent Host
┌─────────────────────────────────────────────────────┐
│ Agent runtime                                       │
│      ↑ wake/resume                                  │
│ Event Intelligence                                  │
│   ├─ source discovery + cursor persistence          │
│   ├─ trigger planning + schema validation           │
│   ├─ composite correlation                          │
│   ├─ temporal state + durable deadlines             │
│   ├─ derived events + contract registry             │
│   └─ activation hydration + inspector/simulation    │
│      ↑ events only                                  │
│ Host-owned MCP clients                              │
│   ├─ GitHub MCP  ── tools + optional Events         │
│   ├─ Gmail MCP   ── tools + optional Events         │
│   └─ Custom MCP  ── tools + optional Events         │
└─────────────────────────────────────────────────────┘
```

The host remains responsible for MCP transports, authorization, credentials and ordinary tool calls. Event Intelligence does not proxy those tools and does not reconnect provider MCP servers itself.

## 1. Ingress

Two ingress families are supported.

### Host-owned MCP Events sources

The host passes a registry/manager for its already-connected MCP clients into the package. EI enumerates that registry and may subscribe to registry changes, so individual provider connections are not listed manually.

For each discovered client, Event Intelligence:

1. reads/discovers its advertised capabilities;
2. checks for the experimental Events capability;
3. loads descriptors through `events/list`;
4. polls compatible sources through `events/poll`;
5. persists opaque cursors and event deduplication state.

No provider URL, OAuth token or API key is copied into Event Intelligence. A tools-only MCP connection is ignored by the Events layer and remains fully available to the host/agent.

The public adapter accepts the official TypeScript MCP client shape or a custom host request function, so private/custom MCP servers can participate without an Event Intelligence-specific connector.

### Provider-native adapters

Standalone or legacy deployments may still ingest native push events. The GitHub webhook adapter maps provider deliveries into a provider-neutral event occurrence before the composite engine sees them.

Transport and correlation remain separate.

## 2. Composite trigger program

A trigger is a versioned typed program containing:

- named event clauses;
- structured predicates;
- expression: `allOf | anyOf | sequence | count`;
- deterministic correlation keys;
- optional semantic correlation;
- temporal conditions;
- lifecycle policy;
- optional continuation contract describing what the runtime should do after activation;
- zero or one runtime target;
- zero or one derived-event output.

For common agent-authored cases, `planTrigger()` compiles a simpler plan into this canonical program. Planning is deterministic: it resolves live scoped event sources, fills server IDs, validates predicate paths against advertised payload schemas, and returns the canonical definition plus required connection IDs.

A trigger must produce at least one effect: runtime wake, derived event, or both.

## 3. Temporal state

Supported temporal operators include calendar windows, absence, not/unless, after/until, debounce, threshold, rate and distinct.

### Two clocks

Event windows are based on event-time (`occurredAt`).

Absence/deadline progression is based on Event Intelligence processing-time. Pending deadlines are persisted and later materialized as internal `event-intelligence.timer.reached` events.

This means a match can progress even when the external world emits nothing.

## 4. Derived events

A matched trigger may produce an immutable derived event:

```text
pr.merged + deploy.succeeded
          ↓
    release.ready@1
```

Derived occurrences receive deterministic IDs, project only explicitly configured fields/constants, preserve direct-parent refs and flattened root evidence, persist before fan-out and re-enter the same composite engine.

Cycles are rejected and runtime recursion has a hard depth guard.

## 5. Contract registry

Every derived-event producer declares a `contractVersion`.

The registry stores event name, contract version, canonical payload schema, SHA-256 schema fingerprint and registered producers. Within one version compatibility is strict structural equality after canonicalization. Multiple versions may coexist; ambiguous unversioned consumers fail closed.

## 6. Runtime wake and activation

Embedded harnesses can provide one in-process wake dispatcher for all agents, or runtime-specific handlers. The wake packet carries `target.runtime`, `target.kind` and `target.id`; the harness uses those fields to resume the correct task/session/agent. One Event Intelligence runtime can therefore serve a multi-agent harness.

The wire wake stays small and reference-only. For composite-trigger wakes, Event Intelligence can hydrate the stable wake ID into an Activation Envelope containing the target, persisted continuation, trigger/match state, and matched evidence according to the continuation context policy. Embedded wake callbacks receive this envelope as an optional second argument.

Matched event payloads are explicitly untrusted external evidence. Hydration supplies context, not authority; the runtime remains responsible for re-reading authoritative state through its normal authenticated capabilities before performing writes.

Standalone deployments may instead configure signed HMAC callback targets.

## 7. Lifecycle

Trigger lifecycle supports:

```text
active ↔ paused
   ↓
completed | expired | deleted
```

Policies include one-shot, maximum firings, cooldown, explicit expiry, lease and completion on goal. Updates create a new immutable trigger version.

## 8. Persistence

The bundled reference backend uses append-oriented JSONL streams and in-memory indexes rebuilt at startup. Non-default scopes are physically partitioned under separate store directories, and writes/claims are serialized inside one process.

Validated properties include scoped restart/cursor/match/deadline recovery, derived-event and contract recovery, durable wake retry/lease recovery, stable replay decisions and hash-linked audit verification.

Storage is injectable. Horizontally scaled custom backends must preserve scope isolation and implement wake claim/lease operations atomically across processes.

Not provided by the bundled JSONL backend: cross-stream ACID transactions, horizontal multi-writer safety, HA failover or external immutable audit retention.

## 9. AI boundary

The deterministic runtime is model-free. Event Intelligence does not run a second agent/planner.

The bundled TypeSafe Jev evaluator is used only when a trigger explicitly requests semantic correlation and `TYPESAFE_API_KEY` is configured. Embedded hosts may inject their own compatible semantic evaluator.

Natural-language interpretation belongs to the surrounding agent/harness. For common cases it can submit an agent-friendly plan to EI's deterministic planner; advanced integrations may submit the canonical trigger definition directly.

## 10. Observability

The Trigger Inspector renders deterministic engine state: satisfied/missing clauses, temporal conditions, pending deadlines, next evaluation, evidence refs, derived outputs, runtime wake/receipt and why-fired/why-not-fired state.

Simulation runs the same trigger semantics against an isolated event sequence without mutating live state.

## 11. Security model

The design minimizes authority propagation:

- the host retains MCP credentials and authorization;
- Event Intelligence receives only explicitly delegated client objects;
- providers remain authoritative for provider data;
- trigger creation is source-scoped;
- agent persistent mutations require confirmation;
- event receipt grants no new tool authorization;
- wire wake evidence is refs-first;
- hydrated matched evidence remains explicitly untrusted;
- large/sensitive or authoritative provider state should be re-read through the host's authorized tools.

See [SECURITY-MODEL.md](SECURITY-MODEL.md).
