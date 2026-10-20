# PostgreSQL terminal wake history retention — bounded operator contract (#47)

**Status: partial retention coverage, NOT complete lifecycle TTL or #47 acceptance.**

## Safety

`PostgresEventStore.compactDeliveredWakeDuplicateHistory({ wakeId, before,
maxRows = 100, maxHistoryRows = 10000, maxScanMs = 2000, dryRun = true })`
is optional, scope-bound and **dry-run by default**. The operator must
select a concrete wake ID and a past ISO cutoff with explicit UTC offset.
The public method rejects malformed options; it does not install an
automatic TTL job or grant an agent deletion authority.

Before any deletion it requires BOTH an authoritative `wake_delivery`
with `status: delivered` and nonempty `runtimeReceiptId`, and a latest
persisted wake history record with `status: delivered`. For a missing,
pending, retryable, failed, dead-letter or unreceipted wake it **skips**.
It never modifies the authoritative wake-delivery row or receipt.

The only eligible deletions are *interior* consecutive byte-equivalent
JSONB wake snapshots strictly before the operator cutoff. The first and
last witness of each duplicate run, every distinct transition
(`queued → delivered` etc.), and the newest/latest wake are retained.
The physical transaction holds the same per-wake advisory fence used
by **both** normal `appendWake()` and
`appendDeliveredWakeIfMissing()`, across separate pools.

No MCP occurrence history or dedup key, trigger state, trigger-match
history, host receipt, source event, audit chain or retained external
provenance is compacted. The operation **does not prove GDPR-style
erasure**: duplicated event data may remain in other retained records.

## Bounded execution

`maxRows`: 1..1000 deletions per transaction.
`maxHistoryRows`: 3..100000 visible revision scan cap; larger histories
fail before mutation with `EVENT_INTELLIGENCE_WAKE_HISTORY_SCAN_BUDGET_EXCEEDED`.
`maxScanMs`: 100..30000 milliseconds per SQL statement including lock
wait and physical dead-index traversal; default 2000. PostgreSQL
SQLSTATE 57014 aborts the entire transaction and maps to
`EVENT_INTELLIGENCE_WAKE_HISTORY_TIME_BUDGET_EXCEEDED`. This is a
**time budget**, not a guarantee of physical tuple count or an SLO.
Do not assume every request must finish within exactly `maxScanMs`,
since the budget is per statement and also includes transaction setup.

## Operator procedure

1. Use a disposable PG16 clone, verify `getWakeDelivery(wakeId)` and
   `latestWake(wakeId)` are durably delivered, checkpoint/pin the
   external audit proof and take an off-host snapshot if retention
   requires recoverability.
2. Execute a dry-run on **one** scoped wake ID. Confirm `eligible`,
   `capped`, cutoff and the associated lifecycle policy.
3. Repeat with `dryRun:false` in small batches, observing statement
   timeouts, concurrent writers and PostgreSQL VACUUM/index health.
4. Recheck `latestWake`, `getWakeDelivery`, absence of redispatch,
   `listAudit`/audit chain verification and tenant isolation.
5. If policy requires removing actual MCP events, audit history or
   source-event payloads, **STOP**. This method never performs that
   lifecycle-wide deletion; define and test off-host archive pinning,
   replay-cursor floors and new chain genesis semantics separately.

## Real PostgreSQL evidence

`test/postgres-wake-history-retention.test.mjs` validates two independent
PostgreSQL pools racing on one wake, exact duplicate snapshots and
distinct transitions, receipt-backed terminal admission, tenant
isolation, disabled compaction for nonterminal rows, dry-run, scan
overflow before deletion, writer-lock statement timeout and
transaction rollback. It also verifies `verifyAudit()` and successful
receipt dedup after compaction.

**Remaining #47 gates:** append-only source-event and audit retention
under a fully defined archival/replay policy, sustained multiworker
crash/partition fault soak, and separately attributable real provider,
external host and PostgreSQL SLO evidence. No production SLA is claimed.
