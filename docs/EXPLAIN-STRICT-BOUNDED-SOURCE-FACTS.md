# Strict inspection of durable MCP source facts — bounded SQL evidence

For PostgreSQL-backed Event Intelligence scopes, strict `TriggerInspector`
(`inspectionWindowLimit:1..100` together with explicit evidence and match
history limits) can now include **persisted source gap, terminal subscription
NotFound and evaluator truncation evidence** without calling unbounded
`listEventSources()`.

`PostgresEventStore.listBoundedEventSources({limit})` selects at most
`limit + 1` rows with indexed **scope_id + kind + record_key** ordering
from the primary key, and runs under a 1,000 ms PostgreSQL
`statement_timeout`. It returns a stable `hasMore` flag.
`getBoundedInspectionFact` performs a separate source-binding check
against the current trigger/version/attached connection set; if more
sources exist than the requested bound it returns **no optional source
fact**. This avoids false confidence from an incomplete subset,
even if the relevant source would happen to be among the first results.

Missing custom-store support never falls back to an unbounded inventory.
The existing non-strict path is unchanged. The optional
per-match evaluator-truncation audit lookup has its own 2,000 ms
PostgreSQL statement timeout. The source list is sorted by key, not
filtered by unindexed JSONB fields; explicit trigger-state and
subscription-state reads remain scope-keyed.

A strict inspection with 1–100 configured sources can diagnose actual
persisted source gap / terminal NotFound. Above that count it
**conservatively reports a local or unknown condition** rather than
claiming source completeness. It does not infer upstream outage,
watermark finality or impossible matches. The first hard statement-timeout
on the source/audit query fails closed.

Evidence: real PostgreSQL16 two-tenant restart integration with strict
gap and terminal NotFound, plus an inventory overflow test that expects
unknown even when a legitimate unavailable source exists. The bounded
inspector's existing 1k/10k/100k match/deadline benchmark remains
separate; this does **not** certify every database query planner path,
all huge JSONB values or production P99 latency without representative
independent host traces.

Review hardening: an optional host `listBoundedEventSources()` returning null, undefined, a malformed page, a missing hasMore flag or a flagged incomplete window **must return no source fact**. The unbounded `listEventSources()` fallback is now exclusive to non-strict mode; adversarial custom-store tests throw if it is invoked by the strict path.

## Bounded certification lookup

Strict inspect can call the PG16 `getVerifiedInspectionFrontier` for the
single source of a missing clause only after the existing bounded source
inventory has proven complete. It reads the certified frontier and current
MCP state under the same gap-fence lock as source updates, rejects stale
revisions, and uses the existing exact-key 64 KiB match read, never an
unbounded latest-match or source-inventory scan. SQL/lock elapsed time and
production SLO still require separate representative measurement.
