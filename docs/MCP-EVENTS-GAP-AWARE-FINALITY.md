# MCP Events delivery gaps and negative CEP finality (v1 experimental)

Tracks #166 C. This is an **internal fail-closed semantic boundary**,
not a claim that the experimental SEP-3415 defines authoritative replay.

## Durable evidence

Both JSONL and PostgreSQL scoped stores now retain
`gapUnresolved: true` with a first `gapDetectedAt` timestamp whenever a
poll page reports `truncated:true` or a host push/webhook adapter calls
`onGap`. Subsequent healthy `events/poll` pages or `onActive`
heartbeats may reset their *page-level* `truncated` value, but **cannot
implicitly clear a historical delivery gap**. Already persisted legacy
`truncated:true` states are interpreted as unresolved.

A host can explicitly call `McpEventsClientManager.acknowledgeReconciledGap`
on an attached connection after independently replaying/validating the
missing history. This is an **embedded, host-only method**, not an MCP
tool, provider notification or LLM capability. It requires
`evidenceId` (a non-secret, bounded reference to the host's verified
reconciliation receipt), scopes the update to the attached connection
identity and current tenant's store, and persists the receipt ID.
**The host is responsible for verifying the receipt and replay**, not
EI; receiving `hasMore:false`, a larger cursor or a healthy heartbeat
is not replay proof. Do not expose this method to an untrusted agent
without a separate host authority check.

## Scoped negative safety

The CEP engine consults scoped durable MCP client state and the
trigger's connection bindings. It compares the canonical server ID,
event name, argument JSON and authorized connection ID; gaps on
unrelated sources/tenants are ignored. The four negative operators
`notPresent`, `notNext`, `notFollowedBy` and `absence` refuse
to assert negative candidates if any forbidden dependency has an
unresolved gap. They return incomplete `truncated:true` evidence;
unaffected positive `anyOf` branches may still match.

A pending temporal deadline for an affected negative is **left pending**
rather than marked fired or cancelled. On due timer ingress, the
engine returns no result until host repair; this prevents a false
negative wake and lets the existing scheduler re-evaluate later.
The scheduler's once-per-interval polling is separate from the agent
loop; no unbounded immediate retry is introduced.

**Limitations:** The conservative gate applies to every candidate
interval for a matching unresolved source because the draft provides
no trustworthy gap interval/watermark proof. This may defer a valid
absence for that source until replay, but does not suspend other
sources. A late-discovered gap cannot undo an earlier committed wake:
host reconciliation/compensation is mandatory for irreversible
effects. Source identity must still be scoped to the authorized
connection; a definition missing server ID is treated
conservatively. A host that invents an acknowledgement without actual
verified replay defeats its own correctness contract. This code does
not provide a cryptographic replay attestation or full producer-side
transport conformance.

## Recovery across all negative forms

A negative anchor observed *while a gap is unresolved* must not be
discarded permanently. For `notFollowedBy` and `absence`, the evaluator
retains a bounded, durable `incompletePending` timer at the original
event-time deadline. For snapshot `notPresent` and `notNext`, it
persists an already-due retry using the anchor event time, with a
deterministic deadline identity. These retry hints are **never** matches
or wake approvals. Every scheduler pass leaves their deadline pending
until the host reconciles missing upstream history; after explicit
reconciliation the scheduler re-evaluates the stored source events
and may emit a valid match exactly once. Positive branches within
`anyOf` are evaluated normally even if a sibling negative branch
is gap-blocked.

A provider's own-data `truncated:true` poll marker is durably written
**before** validation of other page fields and before delivering events
to the CEP engine; a rejected malformed page does not advance its cursor.

## Tests and migration

- `test/mcp-events-gap-aware-negative-finality.test.mjs`: real
  JSONL CEP + scheduler, clean/gap/late/unrelated source/physical restart
  witnesses and tenant scope store isolation.
- `test/mcp-gap-negative-ast-guards.test.mjs`: all four negative AST
  branches, unaffected positive `anyOf`, canonical source arguments,
  server/event/connection precision.
- `test/mcp-events-sep3415-poll-floor.test.mjs`: real host-owned poll,
  sticky gap despite healthy page, physical reopen, explicit
  host-authoritative evidence acknowledgement.
- `test/mcp-events-gap-negative-recovery-restart.test.mjs`: all four
  negative operators complete after verified host repair, one effect,
  restart persistence and no duplicate deadline.
- Existing `test/mcp-events-stream-untrusted-bounds.test.mjs`
  covers push/webhook `onGap` callbacks and untrusted ingress
  boundaries; new state flags use the same `saveSubscriptionState` path.

This is a **pre-v1 migration in negative match finality**, not a
historical wake rollback. Existing deployments must replay or
explicitly reconcile recorded gaps before permitting new
absence-trigger wakeups; prior irreversible actions need host review.
No npm publication and no Artemis/Muffin changes are included.

## Independent P1 review hardening

A producer may attach ordinary events to a `truncated:true` poll page.
EI now durably records the unresolved delivery gap **before the first
such event enters CEP**; only after successful page event ingestion does
it checkpoint the producer cursor. A failure between these steps keeps
an unresolved gap and the prior cursor, never a false-complete negative.

An anchor arriving when a gap is **already known** still creates a
bounded `incompletePending` deadline hint for `notFollowedBy` or
`absence`, without emitting a match. The scheduler retains this durable
deadline while the gap remains open and retries evaluation after host
reconciliation, so a correctly absent event can eventually finalize
without a new source occurrence. The hint is not a conclusive semantic
result and cannot create a wake.

On due timers, the engine continues to evaluate unaffected positive
branches (including `debounce` inside `anyOf`). The scheduler marks a
Pattern v2 deadline fired only when a resulting matched signature equals
that deadline's condition ID. A positive timer does not consume an
independent gapped negative timer. Dedicated tests exercise all three
review failures, real JSONL persistence and host replay recovery.
