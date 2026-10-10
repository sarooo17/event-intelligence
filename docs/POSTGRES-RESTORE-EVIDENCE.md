# PostgreSQL restore evidence — bounded operator simulation

Tracking [#47](https://github.com/sarooo17/event-intelligence/issues/47) and [#50](https://github.com/sarooo17/event-intelligence/issues/50).

The test `test/postgres-restore-evidence.test.mjs` runs in the existing **real
PostgreSQL 16** CI job. It creates a source set of EI tables and a separate
fresh destination prefix, populated with two colliding trigger IDs in different
tenant scopes. A test-only SQL helper copies all five EI relation types
(records, append-only history, leases, counters and schema metadata) in a
single PostgreSQL repeatable-read transaction. The history BIGSERIAL sequence
is then advanced to prevent conflicting IDs after restoring.

The test checks:

- A deliberately interrupted copy **rolls back** instead of leaving a
  partially restored target or stamping inconsistent schema metadata.
- A full restore reopens through the actual `PostgresEventStore.init()`
  version/shape gates, preserving trigger states, match revisions, stable
  wake receipts and audit hash-chain verification.
- Tenant B's identical trigger ID remains isolated from tenant A's wake,
  provenance and audit history.
- A **coordinator-generated** wake and stable runtime receipt cannot be reclaimed after restore; the real WakeRetryScheduler and CompositeWakeCoordinator do not invoke the deliverer again for the restored fired match. This is not inferred from a synthetic wake ID.
- Post-restore append operations continue the audit and match history without
  serial-ID collisions.

Run:

```bash
POSTGRES_URL='postgresql://...' npm run test:postgres
```

**Limitations:** This is **not** a production backup/restore command, nor an
off-host `pg_dump`/`pg_restore` test or live disaster-recovery drill. It
exercises transactional consistency in a **single running PG instance**
under quiesced-writer assumptions. It does not simulate DB loss, corrupted
backups, WAL replay, schema upgrade, version-skewed writers, cross-region
failover, physical node failures, RPO or RTO. Operators should continue to
take verified snapshots and run periodic independent recovery drills using
their existing PostgreSQL tooling. Those checks and HA/scale objectives stay
open in #47.
