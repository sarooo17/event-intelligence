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


## Actual evaluator budget exhaustion (persisted audit)

The canonical Pattern AST v2 runtime already records
`trigger.partial` audit transitions with `details.truncated`
set from its actual evaluator result. JSONL and PostgreSQL now expose
a read-only **latest transition for the selected match ID**. When its
authenticated trigger/version identity matches the inspected
definition and the most recent transition is a partial evaluation
with `truncated:true`, v2 reports `budget_truncated`, not a
conclusive `not_yet_satisfied`. A subsequent complete evaluation
with `truncated:false` supersedes the older evidence; selected-match
identity and tenant scope are enforced at the persistence layer.

Unit/integration tests feed the real canonical evaluator an adversarial
bounded candidate sequence, persist the resulting actual exhaustion,
close/reopen JSONL and verify the diagnosis, then supersede with a
complete transition. PG16 tests verify that identical match IDs in
different tenants do not share that audit fact and the pinned scoped
hash chain still verifies.

The PostgreSQL audit lookup is protected by a 2,000 ms statement
timeout and selects the latest scope-local matching audit row. This
does not prove source watermarks, connection outages or semantic
impossibility; those remain unknown unless separate authoritative
evidence is available.

## Review fix — selected match refreshes buffer completeness

Successful Pattern evaluations can leave a retained buffer under its original match ID while emitting a selected match under another ID. Previously its last `trigger.partial` audit could remain truncated even after the newer successful evaluation. The engine now writes current `trigger.partial` evaluator-completeness audit against the **buffer ID** also when results are produced, so the latest-scoped-audit fact is not stale. The original `!results.length` audit path remains unchanged. Codex P2 on #325.


## Strict-mode high-cardinality exclusion (Codex P2)

Generic `getInspectionFact` currently enumerates the source inventory for
source-gap evidence; its legacy PostgreSQL `listEventSources` path is **not
strictly bounded on the server**, even when the inspector has an
`inspectionWindowLimit`. Strict-mode inspection therefore **does not call**
this optional fact provider: it returns only the locally persisted bounded
match/deadline/derived evidence, with `upstreamCompleteness:'unknown'`.
This conservative omission prevents extra source reads from bypassing the
strict mode's cost guard. Normal inspection continues to expose durable
`source_gap_unresolved` and `budget_truncated` facts.

A future strict fact capability must add genuinely scope/key/indexed,
statement-timeout/byte-bounded evidence access; output-only caps or a
JS-filtered full source inventory are insufficient. Added a regression
with poisoned unbounded `getInspectionFact`/`listEventSources` methods.
