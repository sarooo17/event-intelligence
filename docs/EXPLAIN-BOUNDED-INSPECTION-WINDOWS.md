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
