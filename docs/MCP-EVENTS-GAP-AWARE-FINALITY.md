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
missing history.
The call requires `expectedCompletenessRevision`: the exact persisted
source-state revision against which the host verified replay. The host must
capture that revision as part of its reconciliation evidence, not simply read
the newest revision after replay and assume it was covered. Both JSONL and
PostgreSQL enforce the revision comparison inside the same serialized write
or locked transaction that clears `gapUnresolved`. A newer poll/push/webhook
gap (or any intervening state write) causes a fail-closed
`MCP_EVENTS_GAP_REVISION_CONFLICT`; the host must verify/replay the
new state before retrying, **not** automatically retry with the latest
revision. Missing or malformed expected revisions are rejected.
 This is an **embedded, host-only method**, not an MCP
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

## Atomic finality fencing and deadline reconciliation

At the point a negative (or mixed-pattern) candidate would be
persisted, a source-state snapshot from the evaluator's read is compared
against the authoritative scope-local source-state snapshot **within
the same serialized/transactional commit**. A stale snapshot prevents
the match write and triggers one bounded reevaluation to retain any
missing negative retry deadline. The JSONL reference store uses its
serialized mutation queue. PostgreSQL takes a shared per-scope
transaction advisory lock for both MCP source-state mutation and
conditional match insertion, then checks the state projection before
writing match history. This defines a linearization point for a newly
reported provider gap; if the provider reports it only *after* the
match was committed, the host's compensation/late-data contract still
applies.

The fingerprint is an exact, deterministic canonical representation
of the scoped delivery-completeness records (limit 16,384 records),
not a hash that could collide. Scope serialization has throughput
costs; benchmark and partition appropriately before large-scale use.
Unrelated positive branches retain their own matches. Every buffer
evaluation reconciles pending deadline IDs against its **current**
pending plus gap-retry candidate set, cancelling obsolete debounce
or otherwise superseded timers rather than accumulating them while
another branch is gapped.

Tests include:
- `test/mcp-gap-atomic-finality-race.test.mjs`: force a real gap
  write between CEP's completeness snapshot and match persistence;
  no negative effect, then verified replay recovers exactly once.
- `test/mcp-gap-positive-deadline-reconciliation.test.mjs`:
  replacing a positive debounce event cancels the obsolete deadline
  while retaining an unrelated negative retry deadline.

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

## Concurrent replay / ABA safety

The source-local JSONL/PostgreSQL state now persists a `completenessRevision`
monotonic safe-integer counter (per source record), assigned by the store on
**every** state write rather than accepted from provider/host input. The
scope-local fenced snapshot includes that revision, so `complete → gap →
reconciled complete` is not mistaken for unchanged completeness. Previously
stored records without the new field start at revision 0; their next write
persists revision 1. Overflow or malformed revision is rejected rather than
silently resetting the fence.

The transactional negative-match commit also compares the *exact latest
persisted trigger buffer* against the event buffer used for evaluation. The
JSONL implementation performs both comparisons and the append in one mutation
queue operation; PostgreSQL uses the same scope gap advisory lock as the MCP
state writer, then locks/reads the relevant trigger buffer before appending
the match. On a stale completeness or buffer fence, the engine reloads the
latest durable buffer and performs at most one immediate re-evaluation. If the
second evaluation is also stale, it retains an exact-candidate due-now durable
retry, never committing from an obsolete buffer. This is a fail-closed release
contract; it does not promise cancellation of effects already committed before
a producer reported the gap.

`test/mcp-gap-aba-buffer-replay-fence.test.mjs` deterministically covers the
ABA open/reconcile race with a forbidden replay occurrence, a buffer-only
concurrent replay without any gap-state change, persisted revision across
restart, and rejection of caller-forged revisions. These cases must pass
alongside the existing multi-gap and PostgreSQL CI gates before merge.

## Revision-conditional host acknowledgement

Independent Codex review identified a race between host receipt verification
and concurrent provider gap reports on another PostgreSQL worker. A local
`withConnectionMutation` queue only serializes one manager, so it cannot
replace a durable scope/source compare-and-set.

`acknowledgeReconciledGap({ connectionId, eventName, arguments, evidenceId,
expectedCompletenessRevision })` forwards the host's verified revision into
`putMcpClientState`. When `gapReconciled: true`, the store atomically checks
that the currently persisted source revision is exactly the verified revision
and that a gap remains unresolved. A stale revision rejects without changing
the gap, cursor, receipt, revision or audit state. This prevents a late host
acknowledgement of gap #1 from erasing newly recorded gap #2. A valid
acknowledgement increments the revision and persists the evidence reference.
The host owns the semantics and authenticity of the evidence; EI never
auto-accepts a fresh source revision on a previous receipt.

Regressions:
- `test/mcp-events-gap-reconciliation-cas.test.mjs` exercises JSONL CAS,
  physical reopen, required input, and a host manager that reads an older
  gap before another writer saves a fresh truncated page.
- `test/postgres-shared-state.test.mjs` runs the same stale
  acknowledgement scenario against two independent PostgreSQL workers.
