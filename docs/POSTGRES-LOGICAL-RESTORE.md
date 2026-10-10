# PostgreSQL logical backup and restoration evidence

This document describes a **real PostgreSQL 16 logical pg_dump/pg_restore** test,
not a physical base-backup/WAL test or a promise of a production RPO/RTO or continuous-recovery guarantee.
Issue #47 and #21 remain open until the broader fault-injection, retention
and measured 1k/10k/100k workload requirements have evidence.

## Isolation and authority

EI is embedded. The host/operator owns its PostgreSQL credentials, HA
deployment, policy, maintenance windows, secrets and off-host backup
retention. EI must not invent permission to read an unrelated tenant or
recover another runtime's agent work. Never distribute credentials or backup
archives to model tool execution.

The CI test `test/postgres-logical-backup-restore.test.mjs` requires
`POSTGRES_URL`, `pg_dump`, `pg_restore`, Node >=22 and a testing role
permitted to create/drop **an isolated test database**. It uses a random
unique EI tablePrefix, backs up all five PostgreSQL durable tables and the
history BIGSERIAL sequence, and restores into a second newly created DB.
It does not read or drop ordinary production EI tables. A logical dump is not PostgreSQL physical/base-backup recovery.

The test verifies:
- persisted trigger definition and paused lifecycle survive a logical dump
  and restoration with the schema-version marker accepted at cold startup;
- owner/scoped read isolation still holds;
- delivered wake's **host receipt ID** remains present and the wake cannot be
  claimed/delivered a second time after recovery;
- tamper-evident audit history verifies before and after, and newly appended
  audit entries remain valid (including restored sequence behavior).

The restore test stops writes before `pg_dump`. It does **not** simulate
an independent host side effect during a crash, live PITR/WAL restore,
network partitions, provider cursor races, object-store backups or a
service-level recovery-time objective.

## Operational backup and reset decision

**Never silently reset or migrate PostgreSQL EI state.** Current schema marker
v1 is checked fail-closed against unknown marker values and invalid table
shape. For incompatible future versions, an operator must:

1. Quiesce host EI workers/writes and preserve externally held wake receipts,
   matching/ingress cursors and any host-owned continuation mapping.
2. Take a tested full database snapshot off-host (including sequences,
   metadata marker, history, records, leases and counters). Keep archive
   credentials under host/operator control.
3. Restore to an isolated database, verify expected schema marker, trigger
   counts, tenant ownership, receipt dedup and audit chain before traffic.
4. Explicitly approve cutover or reset. Never run mixed-version EI workers
   against an unknown or incompatible persisted schema.

Exact production `pg_dump` commands depend on operator RBAC and deployment
schema; the test implementation is an executable reference for a sandbox.
No automatic backward-compatibility reader, second runtime scheduler or
secret-bearing telemetry is added.

## Idempotency caveat

Wake delivery remains **at least once until the host cooperates**: an external
side effect that happened just before a crash but before durable receipt
commit can be retried. The host must use the stable wake/receipt ID and
idempotent acknowledgement; database restore alone cannot make an arbitrary
external API action transactionally exactly once.
