# PostgreSQL terminal match-revision history thinning — bounded first slice (#47)

## Contract

This is **not general append-only history TTL** and does not yet complete the
retention/compaction acceptance in #47. It provides a narrowly scoped,
operator-invoked, *dry-run by default* operation:
`PostgresEventStore.compactTerminalMatchDuplicateHistory({ matchId, before,
maxRows, maxHistoryRows, maxScanMs, dryRun })`. `before` must be an offset-aware ISO
timestamp no later than the current clock time; `maxRows` ranges 1–1000
(default 100). `maxHistoryRows` is the maximum indexed revision count the
operator permits scanning (3–100000, default 10000). Histories exceeding
this ceiling fail closed with `EVENT_INTELLIGENCE_MATCH_HISTORY_SCAN_BUDGET_EXCEEDED`
**before** any destructive SQL; a scan-budget failure is not truncation
or silent partial compaction.

**Physical SQL time guard:** PostgreSQL `OFFSET` counts only visible rows:
dead index tuples left behind by repeated compaction or delayed VACUUM
can still require extra work. `maxScanMs` (100–30000 ms, default 2000)
sets a transaction-local `statement_timeout` for EACH statement under the
writer fence (including advisory lock acquisition, count probe, window
selection and DELETE). A statement timeout aborts the entire transaction
and is surfaced as `EVENT_INTELLIGENCE_MATCH_HISTORY_TIME_BUDGET_EXCEEDED`,
with **no committed deletion**. This is a finite per-statement wall-clock
budget, NOT a count of physical index tuples read nor a universal p99 SLA.
Operators should monitor vacuum/index health and use conservative budgets
rather than treating a successful visible-row OFFSET as a guarantee of
bounded heap or index I/O.

Only `trigger_match_history` rows for the *given tenant scope and match ID*
are eligible. The durable current `trigger_match` row must have
`status='fired'`; otherwise the method reports `skipped:'not_fired'` with
zero deletions. It prunes only **interior records in a consecutive run of
byte-equivalent JSONB snapshots**, older than the cutoff, and always retains
the first and last witnesses of that run. Identical snapshots separated by
even one differing revision are separate runs. The candidate window must be
computed over the entire selected match history *before* applying the
cutoff, so boundary revisions cannot be misclassified.

The implementation shares the existing scope/match advisory transaction
lock with match append/finalization, locks the current match row, and selects
and deletes in a single transaction. It uses the existing
`(scope_id,kind,record_key,history_id)` index, with no schema migration or
DDL. Different pools for the same match serialize and cannot double-count
removed history. Maximum deleted rows per call are capped. Before evaluating LAG/LEAD,
a scope-local indexed `ORDER BY history_id OFFSET maxHistoryRows LIMIT 1`
probe verifies the full match revision stream fits the chosen scan ceiling,
under the same per-match lock. Only within-budget streams enter the window.
This avoids an unbounded history materialization for high-cardinality or
maliciously large match streams; it does **not** establish a cluster-wide
retention performance SLO. Operators may raise the explicit ceiling (up
to 100000) only after reviewing database cost.

**Never touched:** original provider/MCP occurrence logs and dedup keys,
event/derived evidence, the current trigger definition/state/buffers,
the current fired match, delivery claims and receipts, wake history,
partition leases, source cursors and gaps, and the entire
**hash-linked audit chain**. This is a loss of redundant revision-history
records under an explicit operator policy, *not* a new guarantee of
lossless forensic reconstruction of every append attempt.

## Runbook

1. Verify a restorable off-host backup and the operator's audit/evidence
   retention agreement. Select a known **fired** match ID in its own scope.
2. Preview with `dryRun: true` (the default), a past `before` cutoff,
   and a conservative `maxRows`. The preview reports `eligible` but
   `deleted: 0`. Another worker might append between preview and apply,
   so treat it as advisory.
3. If the preview reports a scan-budget exceedance, no changes were made:
   investigate the match history and operator budget rather than bypassing
   the ceiling implicitly.
4. Explicitly call the same method with `dryRun: false` to thin only
   interior adjacent duplicates. Repeat bounded batches if needed.
5. Re-check `listTriggerMatchHistory`,
   `getRecentTriggerMatchHistory`, authoritative fired match, receipt,
   host dedup, tenant boundaries and `verifyAudit()` if required by
   the deployment's policy. No background job is installed.

Real PostgreSQL 16 CI:
`test/postgres-match-history-retention.test.mjs` covers three distinct
snapshot runs, bounded dry-run/apply, two independent pools racing for
same-match compaction, other-tenant same-key isolation, refusal on
nonterminal matches, invalid policies, current match and receipt
continuity and an intact audit chain.

## Still blocking full #47 acceptance

Actual operator-defined TTL for raw MCP occurrences, match histories across
large trigger populations, append-only audit material with checkpoint/anchor
and external evidence verification, long-span trace/provenance retention,
and recovery under retention while worker/provider cursor replay happens
**remain unsolved**. In particular, compacting MCP occurrences while source
cursors or negative-event gaps are unresolved is unsafe without more fences.
Do not check #47's compaction acceptance or mark production SLOs green on
this slice alone.

Compatibility: additive advanced PostgreSQL method, no change to public
MCP tools or runtime scheduling; no table/schema/version migration, no regex
refactor, no package release or Muffin/Artemis integration update.
