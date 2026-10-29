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
