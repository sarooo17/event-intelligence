# v1 explainability: honest bounded SDK contract and evidence (#48)

## What is a truthful diagnosis

The versioned explain reason contract distinguishes local lifecycle, selected
partial match, pending/expired deadline, paused trigger, missing/revoked
source, unresolved replay gap, evaluator budget truncation and dead-letter
wake. It cannot assert complete history at an independent MCP producer
without **provider-attested event-time completeness**. Default is
not_yet_satisfied, watermark_pending or upstreamCompleteness:unknown, NOT
candidate_impossible.

A source may assert a selected-candidate impossibility ONLY under a
host-configured **trusted Ed25519 provider key**, exact scope/source/
arguments, per-poll completeness revision, short-lived and nonregressing
completeThroughAt plus independently verified provider semantics.
The signature authenticates the declared frontier, not the truthful
delivery of every event. A forged untrusted MCP event payload, a generic
cursor, clock, or locally observed maximum timestamp are not a proof.

The new end-to-end test signs a real canonical external frontier with a
**test-only signer** and exercises the actual PostgreSQL16 persisted
TriggerInspector. A valid tenant-A scoped claim produces
candidate_impossible only for the selected allOf partial candidate while
upstreamCompleteness remains unknown. Identical IDs in tenant B are
unchanged, an attempted cross-tenant signed replay is rejected, and an
MCP poll revision with truncated history immediately changes A to
source_gap_unresolved and rejects the now-stale signature. The test does
NOT claim a deployed independent provider has such finality guarantees.

## Bounded high-cardinality inspection (SDK target)

Actual strict PostgreSQL16 whole TriggerInspector measurements on PR #371
source-pinned 1,001 / 10,001 / 100,001 same-trigger candidates show
fail-closed ambiguous selection and explicitly keyed bounded retrieval.
The high-tier full-path p99 was **6.163 ms** for refusal and **43.663 ms**
for explicit match ID under its documented isolated synthetic benchmark
conditions (15/20 measurements). PG candidate subquery EXPLAIN BUFFERS
is a component measurement, not independently attributable whole-path
PostgreSQL IO. Real Railway 25-call smoke and steady diagnostics exist,
but the steady load campaign itself had errors.

The enforceable product guarantee is **bounded strict mode**: scope-local
N+1 candidate limits, query timeout, individual/aggregate row size,
total JSON response size and refusal when evidence cannot be inspected
without violating the cap. It is not a universal p99 guarantee at
100k live tenants or an externally maintained host performance SLO.

## Explicit signoff boundaries

#48 acceptance #1 can be checked for the versioned, fail-closed
**conditional explanation contract** only after the integration test
passes and review confirms no fabricated provider finality. Acceptance
#5 can be checked for implemented and actually measured **bounded strict
inspection** only; full operational PG CPU/IO/latency SLO and
independent external provider security remain under required #47 and
#317, and neither gets waived by closing #48.

This is a proposed source evidence reconciliation, NOT certification of
a third-party source's business semantics, deployed host revocation,
production PostgreSQL failover, or stable npm publication. Closing
#48 requires exact-final-HEAD CI, independent review and an explicit
scope decision in the issue; the parent #41 readiness ledger must not
automatically mark full explainability verified from this document.
