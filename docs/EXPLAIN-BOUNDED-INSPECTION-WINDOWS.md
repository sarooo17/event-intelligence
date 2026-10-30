# Bounded inspection windows for deadlines and derived records

`TriggerInspector({store,inspectionWindowLimit:1..100})` opts into an
explicit **fail-closed** window for both the selected match's temporal
deadlines and its derived outputs. Both bounded store methods are required.
Strict mode additionally requires a concrete trigger version, explicit
`matchHistoryLimit` and `evidenceRefLimit`, and the store's
`getBoundedInspectionMatch` method. PostgreSQL refuses oversized
selected match JSONB *before sending it to Node*, using a maximum 64 KiB
logical row budget and a 2,000 ms query time budget. The JSONL reference
store applies that byte cap to its already-loaded in-memory match; the
trigger definition is refused if its serialized bytes exceed 64 KiB.
A store missing any required bounded capability is unsupported in strict mode; it will
never silently fall back to a full scope scan. If either result indicates
more rows than the requested limit, the inspector raises
`EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED`, rather than claiming
a particular reason, next deadline or output count from incomplete data.
The default `inspectionWindowLimit:null` leaves previous behavior and
response compatibility unchanged.

PostgreSQL: scope-local source rows are constrained by the selected
match ID and ordered with `LIMIT limit+1`. The query runs under a
local 2,000 ms statement timeout inside a read transaction. Each row is
conditionally projected as JSONB only if its stored logical size is
under 16 KiB; an oversized matching row fails closed. Valid override
limits are 100..5000 ms, 1024..32768 bytes per row. No arbitrary
untrusted provider strings enter a dynamic SQL identifier.
The JSONL reference store scans its already loaded in-memory Maps and
stops after limit+1 hits, applying the same byte cap.

**Not a universal high-cardinality SLO:** Current selected sourceEvents and
Pattern state are capped at the whole-match row level in strict mode, but a
large pre-existing JSONL store remains materialized and the PostgreSQL
query must still inspect enough rows server-side to find the selected match.
PostgreSQL still filters the
source `records` relation by JSONB match ID, and no new expression
index or max number of scanned rows is guaranteed here. The selected
match's own sourceEvents and patternState may already be large, and
matching runtime/p99 memory benchmarks on 1k/10k/100k real rows still
need a separate production-representative stress gate. Strict mode
bounds returned deadline/derived rows and makes incompleteness an
explicit refusal; it does not satisfy all #48 acceptance #5.


## Raw PostgreSQL16 1k / 10k / 100k read experiment

The opt-in CI workflow
`.github/workflows/postgres-inspector-high-cardinality.yml` checks out
the exact PR commit and stores **raw JSON percentiles plus host specs**
as an artifact. It seeds isolated real PG16 tables with increasing
1,000 / 10,000 / 100,000 unrelated deadline/derived records, then
inspects one fixed trigger/match containing four actual deadline and
four derived records (35 samples after 5 warmups per tier). Per tier,
it records p50/p95/p99/max elapsed milliseconds and positive heap
delta bytes; wrong-match leakage and output cardinality are asserted.
A maximum measured end-to-end call of 2,000 ms is enforced as a
**CI synthetic read envelope**, not a claim that this is a production
SLO. The dedicated strict-mode database statement timeout is 2 s.

This experiment has *no provider network, no independent host* and
does not represent arbitrary production distributions, storage
compaction, mixed tenants under contention, or external failover.
The acceptance #5 may only be checked if the raw workflow evidence is
successful, reviewed, and scoped clearly to the measured envelope.

## Review fixes — complete bounded capability and identity gates

Strict mode now **requires** all bounded store capabilities, notably keyed definition lookup and bounded recent-history; an unsupported custom store cannot silently fall back to `listTriggers()` or materialize all history. A bounded selector result must match the requested trigger ID and version and any explicit match ID before any derived/deadline/history read. A poisoned foreign result is refused as `EVENT_INTELLIGENCE_INSPECTION_MATCH_IDENTITY_INVALID`. These are Codex P2 repairs for #326 and are covered by adversarial custom-store tests.

## Strict historical revision byte protection (#48)

A row-count LIMIT is not a byte limit: one persisted history revision can
contain a large sourceEvents/Pattern-state object. Strict
`TriggerInspector` now requests a 64 KiB per-history-row byte cap and a
2,000 ms query timeout from the PostgreSQL store. The PG16 history query
applies `CASE WHEN octet_length(payload::text) <= maxRowBytes THEN payload
ELSE NULL END` before transmitting a selected JSONB payload to Node and
raises `EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED` if oversized.
The indexed scoped `history_id DESC LIMIT N+1` ordering and
scope/record-key isolation are unchanged. Non-strict inspection retains
the full legacy history behavior. Strict custom stores receive the byte/time
parameters and also undergo a defensive post-return size validation, but
EI cannot prove their external I/O cost without their own bounded storage
implementation. Regressions cover oversized PG rows, normal history,
wrong-scope reads and a misbehaving custom store.

This is a per-row refusal, **not** yet a total inspection-output or
all-path server-side CPU/IO SLO. #48 acceptance #5 remains pending.

## Strict cumulative history transfer ceiling (#48)

The strict inspector now also caps the **total selected history** to
1 MiB (in addition to the 64 KiB individual-revision ceiling).
PostgreSQL applies a windowed byte sum **after** its indexed, scope-local
`ORDER BY history_id DESC LIMIT N+1` selection and conditionally
projects JSONB only when both limits pass. This includes the N+1
truncation sentinel conservatively; an oversized sentinel can make the
inspection fail closed rather than return partial history. The same
2,000 ms statement timeout applies. No history row payload from an
over-budget window is transferred to Node by this path.

Strict custom stores receive `maxTotalBytes` and undergo a secondary
cumulative byte check. Legacy non-strict calls retain unbounded behavior
for backward compatibility. Tests cover PostgreSQL multi-revision
windows, scope isolation and adversarial custom stores.

This is an explicit **history-only** cap. Other inspector output sections,
PostgreSQL server-side work and independent real-host production P95/P99
remain outside this proof. #48 acceptance #5 stays unchecked.

## Strict whole-response serialization ceiling (#48)

Strict inspection now rejects an assembled response larger than 3 MiB
serialized JSON, in addition to its storage-side byte windows.
Custom store deadline and derived record windows are defensively checked
at 16 KiB per returned record and 1 MiB per page, matching the built-in
PostgreSQL per-row bound. Unserializable evidence also fails closed.
No truncated partial report is silently presented as conclusive.

The total serialized-output check is **host-side after** bounded store reads:
it bounds the response sent to a host, not necessarily the SQL CPU, heap
allocated by an untrusted custom adapter or network transfer into Node.
The default non-strict inspector remains backward compatible. This is
partial #48 acceptance #5 evidence, not independent production SLO.

## Strict latest-match cardinality fence (#48)

The strict mode PostgreSQL `getBoundedInspectionMatch` selector now
materializes at most `maxCandidates + 1` rows for one tenant/trigger/version
(default 512; configurable 1..4096) **before sorting candidates by the
existing timestamp/status tie-break**. If the window overflows it refuses
the entire inspection with `EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED`
rather than claiming that an arbitrarily chosen subset is the latest.
Only complete bounded candidate sets may be ranked, and the selected
JSONB is conditionally projected under the preexisting row-byte cap and
2s SQL statement timeout. Exact match-ID lookup still uses the scoped
primary key and bypasses latest selection cardinality.

PG16 tests cover same-trigger overflow, exact-at-cap ordering, other
versions, tenant collisions, empty sets and keyed lookup. This caps the
sort cardinality, **not** arbitrary upstream index traversal or full
database CPU/IO in the absence of an appropriate verified index.
No production p95/p99 or provider completeness SLO is claimed.

## Actual 100k same-trigger candidate stress gate (#48)

The opt-in PG16 1k/10k/100k inspector artifact now includes a **second
shape**: 1k, 10k and 100k persisted matches sharing the very same
trigger ID and version (plus the real selected match). It exercises
strict latest-match selection with a 512-candidate cap under repeated
runs, captures raw p50/p95/p99/max and positive heap delta, and checks
that an over-cap candidate set **always refuses due to cardinality**
(not a misleading latest result or an SQL timeout). It also confirms
that direct inspection of an exact match ID remains available under load.
The CI threshold is a measured synthetic 2s rejection envelope on a
GitHub runner, not a third-party production SLO. Both shapes, data,
runner specs and failure artifacts are included in the 90-day raw job
artifact. This cannot prove arbitrary CPU/IO/index behavior, production
host traffic, or source-provider completeness.

## PostgreSQL physical buffer / executor evidence (#48)

The same isolated 1k/10k/100k matching-trigger benchmark now captures
real `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` output for the strict
selector's **scope/trigger/version + LIMIT 513 candidate subquery**.
Each tier publishes server executor elapsed time, actual returned rows,
PostgreSQL shared hit/read/dirtied/written blocks and plan node types.
It asserts the candidate window never exceeds 513 records and has no
unbounded preselection sort. The host-side final-selector latency/heap
samples are still measured separately. The plan is intentionally marked
`scoped_candidate_limit_subquery_only`: this is **not** a holistic cost
profile of every inspector query, all PostgreSQL locks, cross-host contention,
or a production CPU/P95/P99 certificate. No unsupported production SLO is
inferred from synthetic CI measurements.


## #48 full-path high-cardinality evidence — new PR follow-up

The `postgres-inspector-high-cardinality` CI workflow now measures the
**entire public strict `TriggerInspector.inspect()` method** after
loading **1,001 / 10,001 / 100,001 same-trigger matching candidates** in
actual isolated PostgreSQL16. Both branches are executed on the same
scope, trigger and persisted dataset:

1. **Implicit latest match:** must reject by bounded cardinality
   `EVENT_INTELLIGENCE_INSPECTION_BUDGET_EXCEEDED`; never return an
   arbitrarily truncated or false latest match. Measurements include
   the entire inspector's definition lookup, trigger state and scoped
   match-selector round trips, **15 real post-warmup samples** per tier.
2. **Explicit selected `matchId`:** must continue to inspect the
   chosen partial match, its deadlines, derived lineage, source state
   and bounded output without leaking unrelated event payloads.
   **20 real post-warmup samples** per tier. JSON output must be
   at most 3 MiB.

The source-SHA-pinned `pg-inspector-raw.json` artifact reports wall-time
p50/p95/p99/max for both *whole* inspector calls, per-sequential-call
Node **process-wide** user+system CPU sample percentiles, positive
heap/RSS deltas and actual selected-view JSON output byte count.
Actual PG16 source count and query subplan `EXPLAIN (ANALYZE,BUFFERS)`
remain separately labeled. **Those physical block readings belong
only to the scoped selector subquery, not the entire inspector.**
Client-side RSS/CPU include V8 GC/other same-process effects and are
not an isolated server CPU bill. No real network MCP provider,
third-party host, sustained concurrent user traffic or production I/O
attribution is present. Passing a 2-second *reference diagnostic*
ceiling does not certify the 2-second production SLO, nor any
operational p99 under real contention. CI preserves failure artifacts.

The authenticated Railway private benchmark endpoint has already
produced two real PostgreSQL16 `TriggerInspector.inspect()` reports
from a separate process, recovered via **existing actual operator
logs** on 2026-10-30:

| Actual Railway campaign | Status | Inspect samples | Refusals | p50 / p95 / p99 (ms) | CPU user+system (μs) |
| --- | --- | ---: | ---: | --- | ---: |
| `e9b2deaa-e51c-403a-9e81-3e35f9280089` (smoke) | completed | 25 | 0 | 12.795 / 20.332 / 40.14 | 114,975 + 30,961 |
| `f4656c40-fd17-4b26-b913-6ff8e45d1ad9` (steady) | completed-with-errors | 25 | 0 | 22.482 / 37.382 / 45.5 | 171,289 + 29,189 |

Existing Railway SHA-256 artifact digests:
`cbca0c9093d254f252a66a9888c52ac97e254d08da19238c277edcb3b59df97c`
and
`b89d435fc9925bfe898eb41edfd32aa771daeb02403023150798c74538fe5ce2`.
The second SLO campaign **failed its declared workload coverage**
(even though the inspector diagnostics themselves had no refusals).
Both inspector reports explicitly say
`sourceProviderExternal:false`,
`pgDatabaseGlobalDeltaAvailable:false` and
`productionSloCertified:false`. Do not convert a real Railway
*diagnostic* into an independent deployed host SLO.

**Acceptance discipline:** this PR extends reference bounded cost
evidence for #48 acceptance #5 but **does not fulfill
independently operated real-host/representative external workload
CPU/IO p95/p99**. The source frontier acceptance #1 is also still
blocked: a replay cursor is not a trustworthy event-time complete-through
frontier. Do not check either merely from this PR's green CI.
