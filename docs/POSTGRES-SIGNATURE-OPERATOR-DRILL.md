# Operator-controlled PostgreSQL signature reset/replay drill

**Issue:** #50. **No automatic migration, no npm publishing.** This is
a deliberately destructive test only inside fresh, randomly prefixed PostgreSQL
CI tables, not an operational script that should be run against a customer's DB.

The real PostgreSQL 16 test in
`test/postgres-signature-operator-reset.test.mjs` exercises:
1. A synthetic legacy pre-signature state with schema v1 and a persisted
   trigger plus delivered wake/host receipt, but **no candidate identity
   marker**. New EI must fail startup before any scheduler or match processing.
2. A genuine `pg_dump` archive of all five prefixed tables and history
   sequence, restored via `pg_restore` into a separately created database.
   The independent restored DB retains both trigger and host receipt while
   still failing new-EI startup. The archive is never silently upgraded.
3. Only after verified restoration, an explicit isolated source-table reset.
   Fresh EI initializes a clean signature-v2 marker with **no** old trigger,
   match or host receipt resurrected.
4. An operator-directed trigger recreation and selective external event
   replay through the actual Pattern v2 engine, producing a new match.
   The pre-reset archive remains unchanged.

This verifies the **selected fail-closed backup/reset/replay path in a
controlled isolated PostgreSQL fixture**. It is **not** an operator UI,
migration, proof of real customer source-replay completeness, full
multi-worker stop-the-world coordination, durability of a live host's Turn
store, per-tenant RPO/RTO or disaster recovery for arbitrary objects. It does
not make cross-version workers safe to run together. For actual deployments,
stop and fence old workers, retain off-host backups, reconcile host receipts,
verify authoritative source gaps, and run a dry-run restore on staging first.

The test uses CI-local PostgreSQL client tools. It does not include DSNs
or passwords in process arguments, and sanitized errors are bounded. All
tables/databases are unique to this fixture and cleaned up in `finally`.
