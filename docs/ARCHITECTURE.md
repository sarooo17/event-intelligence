# Architecture

## Position in the stack

Event Intelligence is designed to run **inside the agent host**, next to the host's existing MCP client registry.

```text
                         Agent Host
┌─────────────────────────────────────────────────────┐
│ Agent runtime                                       │
│      ↑ wake / resume                                │
│ Event Intelligence                                  │
│   ├─ event-source discovery + subscriptions         │
│   ├─ deterministic trigger planning                 │
│   ├─ Pattern AST CEP engine                         │
│   ├─ durable deadlines + event-time state           │
│   ├─ derived events + contract registry             │
│   ├─ durable wake delivery                          │
│   └─ activation hydration + inspector/simulation    │
│      ↑ occurrences                                  │
│ Host-owned MCP clients                              │
│   ├─ GitHub MCP  ─ tools + optional Events          │
│   ├─ Gmail MCP   ─ tools + optional Events          │
│   └─ Custom MCP  ─ tools + optional Events          │
└─────────────────────────────────────────────────────┘
```

The host owns MCP transports, OAuth/API credentials and ordinary tool calls. EI reuses the already-connected clients; it does not proxy tools or duplicate provider credentials.

## 1. Ingress

### Host-owned MCP Events

The host passes its MCP registry once. EI discovers Events-capable clients, ignores tools-only clients and can refresh when connections change.

For each compatible connection EI:

1. reads the negotiated capabilities;
2. selects the configured MCP Events compatibility profile;
3. discovers paginated event descriptors;
4. materializes only subscriptions required by active trigger clauses;
5. selects poll, push or webhook delivery according to provider and host capabilities;
6. persists cursor, delivery and deduplication state.

### EventSource and EventSubscription

`EventSource` is provider capability metadata. `EventSubscription` is durable interest in one source plus concrete subscription arguments.

Two triggers consuming the same `(connection, event name, arguments)` share one upstream subscription and fan out locally. Different arguments have independent cursor state.

All delivery modes converge here:

```text
poll | push | webhook
        ↓
 EventOccurrence
        ↓
 CorrelatableEvent
        ↓
 Pattern engine
```

Provider-native adapters remain useful for provider runtimes and tests, but embedded host-owned integration is the primary architecture.

## 2. One trigger architecture

v0.6 has one persisted and executable trigger model:

```text
clauses + Pattern AST + lifecycle/effect
```

There is no parallel `expression + temporal + correlation` execution path.

A clause identifies an event source and structured payload predicates. The Pattern references clause aliases and owns composition, temporal semantics, correlation, aggregation, state and optional semantic reasoning.

The agent-friendly planner is not a second DSL. It validates a `TriggerPlanInput` against live source schemas and produces the same canonical Pattern definition executed by the engine.

## 3. Pattern execution

Each trigger has a global `withinMs` retention horizon. Pattern state is maintained in bounded per-trigger/version/partition buffers.

`partitionBy` defines deterministic partition keys from source fields. In distributed-store mode, partition ownership is protected by backend leases.

Pattern supports:

- nested `allOf` / `anyOf`;
- ordered `sequence` with `next`, `followedBy` and `followedByAny`;
- repeat/optional quantifiers with greedy/lazy policies;
- bounded negative patterns;
- calendar and durable absence;
- debounce, threshold, rate and distinct;
- event-time windows;
- cross-event comparison and arithmetic;
- aggregate and state operators;
- explicit semantic predicates;
- overlap and after-match selection policy.

Candidate expansion, semantic evaluations and buffered events are independently bounded.

## 4. Clocks and durable deadlines

Normal matching uses event time. `occurredAt` is distinct from optional host `receivedAt`.

`eventTime.allowedLatenessMs` controls the watermark and bounded out-of-order tolerance.

Negative patterns, absence and debounce can require progress after the final external event. EI persists deadlines and later injects an internal timer occurrence so the same Pattern buffer can complete after restart.

## 5. Semantic evaluation

The deterministic engine is the default.

A Pattern `semantic` node is the only semantic-condition form. It calls the injected `SemanticEvaluator`. TypeSafe Jev is an optional adapter, not an architectural dependency.

Semantic decisions are bounded by per-pattern budgets and timeout policy. Stable evaluator identity can enable durable decision-cache reuse; decisions and cache behavior remain observable in audit/evidence.

## 6. Derived events

A matched Pattern may emit a versioned derived event:

```text
pr.merged + deploy.succeeded
          ↓
    release.ready@1
          ↓
      Pattern AST
```

Derived events are immutable and re-enter the same graph. They carry direct-parent refs, flattened root evidence, deterministic IDs and an explicit contract version.

The contract registry stores canonical payload schemas and fingerprints. Same-version producers must be compatible; ambiguous unversioned consumers fail closed.

## 7. Runtime wake and activation

A matched Pattern with a runtime target is delivered through the durable wake path.

Wake delivery persists state, uses claim leases, retries with bounds, records runtime receipts and avoids duplicate logical delivery across replay.

The external wake stays small. Embedded hosts can hydrate it into Activation Envelope v2 containing the canonical Pattern, continuation, match state and bounded evidence.

External event payloads are explicitly untrusted. The resumed agent must use its normal authenticated tools to re-read authoritative state before writes.

## 8. Lifecycle

Lifecycle supports active/paused/completed/expired/deleted states plus one-shot, max firings, cooldown, expiry, lease and completion-on-goal.

Trigger updates create a new version rather than mutating the executable definition in place.

## 9. Storage

The bundled `PersistentEventStore` is a zero-dependency, append-oriented JSONL reference backend with in-process serialization and physical scope partitioning.

The store contract supports Promise-backed authoritative reads so a production database does not need process-local fake synchronization.

For horizontally scaled deployment, EI validates backend capabilities. Strong shared mode requires:

- strong shared state;
- strong scope isolation;
- distributed-atomic wake claims;
- distributed-atomic Pattern partition leases.

The remaining production HA roadmap is tracked separately; the reference JSONL backend intentionally does not claim multi-worker safety.

## 10. Control plane and standalone service

The optional MCP stdio server exposes discovery, planning, inspection, simulation and hydration read surfaces by default. Persistent mutation tools require `MCP_WRITE_ENABLED=true` plus confirmation IDs.

The HTTP service is a reference/debug adapter for conformance and provider-native ingress. It is not a second runtime architecture and does not own arbitrary provider MCP credentials.

## Security boundary

Event Intelligence evaluates future conditions; it does not grant authority.

A source event, Pattern match, semantic decision or derived event can justify waking an agent, but the agent's actual actions remain subject to the host's ordinary authorization and policy layer.
