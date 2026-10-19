# OS SIGKILL after actual MCP/Pattern match, before wake: contending workers (#47)

## What this test actually exercises

The test `test/postgres-os-matched-contenders.test.mjs` uses a real,
disposable PostgreSQL 16 service and independent Node OS processes:

1. A child with its **own** PostgreSQL pool receives a synthetic
   MCP-shaped event through `CompositeEventConsumer.ingestMcpOccurrence()`
   and the production `CompositeTriggerEngine` (Pattern v2). It commits
   exactly one real trigger match, then signals the parent **before**
   the wake claim/persistence boundary. It cannot run a wake coordinator.
2. The parent verifies the match is durably `matched`, no wake delivery
   is due, then sends **real SIGKILL**. The child must exit with that OS
   signal; disconnecting a connection pool alone is not accepted.
3. Two **different** successor Node processes open independent PG pools,
   wait at a start barrier, then independently enter the **production
   `WakeRetryScheduler.runDue()` path**. The scheduler now discovers
   committed `matched` records with no wake-delivery row through a
   bounded scope-local PostgreSQL query, revalidates the trigger's
   current lifecycle state and target, then calls the ordinary
   `CompositeWakeCoordinator.deliverMatched()` using its existing
   transactional claim fencing. This fixes the real crash-orphan gap,
   instead of manually seeding a wake in the test.
4. A separate PostgreSQL **fixture-host ledger** records every
   deliverer attempt before applying an independent idempotent host
   effect insert. The test requires exactly **one attempted host call**
   and one effect, **one delivered wake/receipt**, attempt generation 1,
   and final persisted `fired` match. The other contender may observe
   `delivery_in_progress`; it must not call the fixture host.
5. The original identical MCP occurrence is replayed through the real
   consumer: it must report `already_fired` and call no host. Finally,
   the parent verifies that durable audit history is intact and total
   external effects equal the number of unique matches.

The repair query returns at most **32 matching records per sweep**
and runs every 30 seconds in the hosted runtime by default. It now
requires **two verified scoped partial B-tree indexes**: on matched
trigger records ordered by match ID and on wake-delivery records by
referenced match ID. The indexes avoid scanning every historical match
or performing an unindexed anti-join on each empty recovery sweep.
Fresh empty PG installations create them at init. Existing populated
databases DO NOT build indexes during startup, because blocking DDL
could stall production writes: an operator must explicitly invoke
`await store.migrateOrphanRecoveryIndexes()` on an initialized store
against the real, session-capable PostgreSQL service. It uses
`CREATE INDEX CONCURRENTLY` with a durable exclusive operator
claim; interrupted or invalid indexes fail closed for the recovery
scan until inspected/rectified. This is a physical database index
migration, with no user-data deletion or schema re-interpretation.
The cursor lives only in scheduler memory; a restart resumes from the
start, and SQL does not mutate any match or audit history.
If a matching trigger has been paused/deleted/expired/completed since
matching, or its `expiresAt` / `leaseUntil` deadline has passed while
durably marked active, the sweep returns `recovery_not_authorized`.
The PostgreSQL delivery boundary also holds the **same session advisory
lock as `setTriggerState()` uses transactionally** across the external
host callback: revocation may only commit before the callback starts
(then delivery fails closed) or after the already-authorized callback
finishes. This requires a real session-preserving PostgreSQL connection,
not PgBouncer transaction-pooling, and a pool with at least two
connections. Hosts must still implement idempotent receipt handling
for process failure after an external side effect. Missing runtime coordinators remain
`runtime_unconfigured`. A separate PG16 regression verifies paused
matches remain pending, not resurrected.

By default, regular PostgreSQL CI executes **four** rounds. A narrowly
opted-in CI job executes **12** real matched → kill → two-contender
rounds only on a PR explicitly marked `[match-chaos]` in its title.
Ordinary PRs incur no additional dedicated CI runner. Results of
that job are meaningful **only if it actually runs and concludes green**.

## Evidence, reproducibility, limits

The special 12-round job uploads the raw JSON, Node TAP output and host
provenance to a retained GitHub Actions artifact. It pins pg@8.16.3,
Node 22 and PG16; the host file reports the exact checked-out head SHA,
GitHub Actions run ID/attempt, CPU and memory. Incomplete or aborted
tests produce `status: incomplete` and no fabricated counts.

Manual isolated local reproduction requires a disposable PG16 and:

```bash
POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/event_intelligence \
EI_MATCH_KILL_ROUNDS=12 \
EI_MATCH_KILL_EVIDENCE_OUT=os-matched-contenders.json \
node --test test/postgres-os-matched-contenders.test.mjs
```

`npm run build` and installation of the optional `pg` driver are required.
No customer table is ever used. The test generates a random safe prefix,
reaps every orphaned worker before cleanup and uses bounded SQL
connection/statement timeouts. The synthetic test fixture does not
modify Muffin/Artemis integrations or regex handling; the separately
documented PG store and wake scheduler changes DO affect runtime
reconciliation and trigger delivery ordering.

**Production behavior and public adapter API DO change.** This PR adds
indexed PostgreSQL orphan recovery, an explicit online index migration,
host delivery / mutation serialization and live lifecycle deadline
guards; it is not a test-only refactor. A single PG16 service is still
used in all jobs. Indexes limit the scan, but the queue cadence,
migration, locks, and host callback durations need operational load and
fault profiling before production SLO signoff. The callback lock can
delay pause/delete until a slow host response or be interrupted on
worker process death; the host must still handle idempotent receipts.

This test does **not** establish an actual upstream provider transport,
durable cursor/ack checkpoint, real external host/network delivery,
slow network or database outage, primary failover, true lease-expiration
under wall clock, or the full distributed work scheduling contract.
Although the fixture-host ledger is a separate table, it shares the
same disposable PG16 instance; it is **not** an independent remote host.
It checks one particularly important post-match crash boundary and
two-worker arbitration, not the whole production chaos acceptance.

Issue #47 compaction, sustained multiworker/partition/rebalance soak,
operational SLO thresholds and measured remote end-to-end latency remain
open. Do not mark them complete solely because this test passes.
