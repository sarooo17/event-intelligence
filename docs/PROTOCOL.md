# Event Intelligence Protocol v0.1

This document describes the current **internal persisted protocol/schema compatibility line**. Package releases are versioned independently; the 0.3.x package still emits the v0.1 internal protocol identifiers for backward compatibility.

Event Intelligence defines a small internal protocol above event transport and below agent execution. It is **not** an MCP specification.

## Layers

```text
event source
  → canonical event occurrence
  → composite + temporal trigger program
  → derived semantic event / versioned contract
  → signed runtime wake
```

## MCP boundaries

Two boundaries are intentionally separate:

- **event ingress:** experimental MCP Events extension negotiation via `capabilities.extensions["io.modelcontextprotocol/events"]`, paginated `events/list`, durable per-argument subscriptions and poll/push/webhook delivery adapters, plus provider-native adapters;
- **control plane:** standard MCP stdio server using the official TypeScript SDK v2, targeting MCP 2026-07-28.

The project does not define a competing base MCP Events protocol.

## Canonical lineage

Accepted source events preserve stable identifiers and payload hashes. Decisions, trigger matches, derived events and wakes remain linked to their source evidence.

Audit records are append-only and hash-linked. This is tamper-evident, not tamper-proof.

## Event subscriptions

MCP Events discovery and EI trigger semantics remain separate. `events/list` yields source descriptors. For an active trigger clause, EI derives a durable subscription keyed by connection, event name and canonical MCP `arguments`. The subscription owns cursor/delivery state; the trigger clause owns the EI `where` predicate.

This preserves two independent contracts:

- MCP `arguments` are validated against the source `inputSchema` and define the provider-side subscription;
- EI predicates are validated against `payloadSchema` and evaluate delivered event data.

Poll, push and webhook all normalize into the same EventOccurrence path before composite evaluation. Existing persisted trigger definitions without `arguments` read as `arguments: {}`.

## Composite programs

A trigger contains:

- event clauses with MCP subscription arguments and structured EI predicates;
- `allOf`, `anyOf`, `sequence` or `count`;
- optional deterministic same-value correlation;
- optional semantic correlation;
- temporal conditions;
- lifecycle policy;
- optional continuation metadata for the runtime activation;
- a runtime target, a derived-event output, or both.

Agent-facing trigger plans are a package-level convenience API. They compile deterministically into this canonical trigger protocol and do not introduce a second persisted protocol.

Unbounded joins and arbitrary code predicates are intentionally excluded.

## Temporal semantics

Normal trigger windows use event time.

Absence and durable deadline progression use processing time. Pending deadlines are persisted so a process restart does not erase the wait.

## Derived events

Derived events are immutable semantic boundaries. They:

- have deterministic IDs;
- re-enter the same event graph;
- project only explicitly configured scalar fields/constants;
- carry direct-parent refs and flattened root evidence;
- are guarded against cycles and excessive recursion.

## Versioned contracts

Every derived-event producer declares `eventName@contractVersion`.

Within one version, producers must have the same canonical payload schema. The contract registry stores the schema fingerprint and producers. Ambiguous unversioned consumers fail closed.

## Runtime wake and Activation Envelope

Runtime targets are operator-configured.

Wire wake packets use stable IDs, refs-first evidence, HMAC signatures where applicable, and runtime receipts. A composite wake may be hydrated locally into an Activation Envelope containing the persisted continuation and matched event evidence. The envelope is a runtime convenience contract; it does not grant authority and labels matched event data as untrusted external evidence.

The implementation claims effectively-once activation only for the validated reference scenarios; it does not claim theoretical distributed exactly-once delivery.

## Governance and security invariants

- a model cannot invent authority by inventing a source, field, runtime target or contract;
- persistent agent-authored mutations remain confirmation-gated;
- event receipt grants no new downstream authorization;
- semantic correlation is optional and probabilistic;
- replay must not produce a second logical wake for an already-fired match;
- the bundled JSONL persistence backend is single-process reference infrastructure, not HA storage;

Executable schemas and invariants live under `src/intelligenceProtocol/`; end-to-end behavior is verified by the test suite.
