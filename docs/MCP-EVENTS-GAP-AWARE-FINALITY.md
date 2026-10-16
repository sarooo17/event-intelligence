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
- Existing `test/mcp-events-stream-untrusted-bounds.test.mjs`
  covers push/webhook `onGap` callbacks and untrusted ingress
  boundaries; new state flags use the same `saveSubscriptionState` path.

This is a **pre-v1 migration in negative match finality**, not a
historical wake rollback. Existing deployments must replay or
explicitly reconcile recorded gaps before permitting new
absence-trigger wakeups; prior irreversible actions need host review.
No npm publication and no Artemis/Muffin changes are included.
