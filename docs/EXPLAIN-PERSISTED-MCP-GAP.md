# Persisted MCP delivery gap explanations

The canonical versioned v2 reason contract now recognizes
`source_gap_unresolved` when the **actual scoped runtime store** already
persists a provider delivery gap with `gapUnresolved:true` and an
incrementing `completenessRevision`. JSONL and PG16 both implement the
optional `getInspectionFact` capability. They first check a real
trigger/version, its host-associated connection IDs and registered enabled
event sources matching a concrete server/event/arguments identity, then
read that one connection's durable client gap state.

A provider cannot set the diagnosis by adding a `kind` field or prose to
an event payload: that is never queried. An unrelated tenant or a
disabled/unregistered connection cannot affect the explanation. Missing
metadata, ambiguous registered source mapping, unknown source status,
or an untracked connection is interpreted as **unknown**, not healthy.

A later successful poll does not silently close a gap. Only the host's
existing CAS-checked source replay/reconciliation mechanism can change
the persisted gap to resolved; the explanation automatically reverts to
`not_yet_satisfied`. Actual JSONL close/reopen and PG16 independent-pool
restart/cross-tenant cases are run in CI and release gates.

**Critical meaning:** a delivery gap is NOT the same thing as an
upstream watermark, a disconnected provider or a terminally impossible
candidate. The newly exposed kind is therefore
`source_gap_unresolved`; `upstreamCompleteness` is always
`unknown`. This is honest real durability evidence toward #48
acceptance #1, **not yet** full production-derived source-outage,
watermark, budget-truncation or impossible-candidate certification.

The lookup currently uses the existing scoped event source listing and
at most 64 attached IDs and 64 clauses, with a 1024-source fail-closed
limit. These guards bound projected evidence, **not** the PostgreSQL
underlying event_source table read. The broader #48 high-cardinality
read/cost acceptance remains separate and requires DB pushdown,
resource budgets, and representative measured stress evidence.
