# Event Intelligence Protocol v0.2

This document describes the current **internal persisted protocol/schema line** used by Event Intelligence v0.6.x. Package and internal protocol versions are independent, but v0.6 intentionally introduces a breaking persisted-trigger boundary: the pre-Pattern trigger representation is no longer accepted.

Event Intelligence defines a runtime protocol above event transport and below agent execution. It is **not** an MCP specification.

## Pipeline

```text
EventSource / EventSubscription
        ↓
canonical event occurrence
        ↓
Pattern AST
        ↓
matched evidence
   ↙            ↘
derived event    runtime wake
        ↓              ↓
same event graph   Activation Envelope
```

There is one trigger execution model: **Pattern AST**.

## MCP boundaries

Two MCP-facing boundaries remain separate:

- **event ingress:** a versioned compatibility profile isolates experimental MCP Events wire assumptions. Host-owned poll, push and webhook delivery normalize into the same occurrence path;
- **control plane:** an optional standard MCP stdio server built with the official TypeScript SDK v2 and targeting MCP 2026-07-28.

Event Intelligence does not define a competing MCP Events base protocol.

## Event sources and subscriptions

An `EventSource` describes an event exposed by a provider: name, delivery modes, `inputSchema`, `payloadSchema` and metadata.

An `EventSubscription` is durable client-side interest in one source. Its identity includes the host connection, event name and canonical subscription `arguments`. Cursor and delivery state belong to the subscription.

Trigger clauses refer to discovered sources and contain:

- a stable clause id;
- event name and resolved `serverId`;
- provider-side subscription `arguments`;
- EI payload predicates in `where`;
- optional derived-event `contractVersion`.

Subscription arguments are validated against `inputSchema`. EI predicates and Pattern field references are validated against `payloadSchema`.

## Canonical trigger

A persisted trigger contains:

- `clauses`;
- required `pattern`;
- global retention bound `withinMs`;
- optional `eventTime.allowedLatenessMs`;
- lifecycle policy;
- optional continuation;
- a runtime target, derived-event output, or explicit `conditionOnly: true`.

The current trigger identifiers are:

```text
protocolVersion: 0.2.0
schemaVersion:   trigger.v0.2
```

The old `expression`, `temporal`, `correlation` and `semanticCorrelation` trigger fields are not part of this protocol.

## Pattern AST

The canonical field is `pattern`. The wire grammar currently uses `version: "2"`; that version identifies the Pattern schema and does not imply a second runtime architecture.

The recursive node set includes:

- `event`, `allOf`, `anyOf`, `sequence`;
- `repeat`, `optional`;
- `notNext`, `notFollowedBy`, `notPresent`;
- `calendar`, `absence`, `after`, `until`, `debounce`, `threshold`, `rate`, `distinct`;
- `window`;
- `compare` with cross-event arithmetic;
- `aggregate`;
- `state`;
- explicit `semantic`.

Pattern definitions also carry optional `partitionBy`, match-selection policy and execution budgets.

The runtime persists bounded state per trigger/version/partition. `withinMs` is the outer retention horizon; duration-bearing Pattern nodes cannot exceed it.

## Event time

Provider event time and host receive time are kept separate.

- `occurredAt` drives sequence, windows, rate, state and matching order;
- `receivedAt` records host observation time when available;
- `allowedLatenessMs` defines bounded out-of-order tolerance and the watermark.

Delivery order is never treated as event order.

## Durable time

Negative/debounce/absence patterns may need to become true without another provider event. EI persists temporal deadlines and later evaluates them through internal timer occurrences.

A restart therefore does not erase a pending wait.

## Semantic nodes

Semantic reasoning is explicit. A `semantic` node declares its child pattern, projected refs/fields, instruction, thresholds, uncertainty policy and execution policy.

Semantic evaluation runs through the vendor-neutral `SemanticEvaluator` interface. TypeSafe Jev is the optional bundled implementation. Calls are bounded, timed out, cacheable and audit-recorded. Deterministic CEP does not require a model API.

## Derived events

A matched trigger may emit an immutable derived event.

Derived events:

- receive deterministic IDs;
- declare `eventName@contractVersion`;
- project only configured fields/constants/measures;
- preserve direct-parent and flattened root evidence;
- re-enter the same event graph;
- are protected by cycle and recursion-depth guards.

Within one derived-event contract version, producer schemas must be structurally compatible. Ambiguous unversioned consumers fail closed.

## Runtime wake

A trigger with a runtime target can enqueue a durable wake. Delivery uses stable IDs, persisted delivery state, claim leases, bounded retry and runtime receipts.

The wire wake remains reference-oriented. Embedded hosts can hydrate the wake into **Activation Envelope v2**, containing:

- target;
- canonical Pattern;
- lifecycle state;
- continuation;
- match/partition state;
- bounded matched evidence.

Delivered event payloads remain untrusted external evidence. Hydration supplies context, not authority.

## Lifecycle

Trigger lifecycle supports:

```text
active ↔ paused
   ↓
completed | expired | deleted
```

Policies include one-shot, maximum firings, cooldown, expiry, lease and completion-on-goal. Updates create a new immutable trigger version.

## Storage contract

Authoritative reads may be synchronous or Promise-backed. A custom backend advertises capabilities explicitly.

The bundled JSONL backend is single-process reference storage. Shared-store mode fails closed unless the backend declares strong shared state, strong scope isolation, distributed-atomic wake claims and distributed-atomic partition leases.

## Security invariants

- a model cannot invent event-source, field, target or derived-contract authority;
- agent-authored persistent mutations remain confirmation-gated;
- event receipt grants no downstream write authorization;
- semantic matching is evidence, not authorization;
- replay cannot create a second logical effect for an already-consumed match;
- tenant/workspace scope is part of the storage boundary.

Executable schemas and tests are authoritative when prose and code disagree.
