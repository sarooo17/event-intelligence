# Stable v1.0 PostgreSQL stored-state operator upgrade and rollback

**Scope:** SDK v1 release gate `stored-state-upgrade` (#41/#50). This is a
**fail-closed operator procedure**, NOT an automated in-place migration or a
production PostgreSQL HA/disaster-recovery certification. The executable
reference is `test/postgres-v1-full-db-operator-upgrade.test.mjs`; CI runs it
on actual isolated PostgreSQL 16 with two tenants, a delivered wake receipt,
a provider cursor/unresolved gap, persistent source history, audit, and a
revoked shared-session epoch.

## Preflight — do not change a live database yet

1. Identify the deployment's exact EI npm version, PostgreSQL 16 server,
   schema marker, Pattern v2 signature marker, the selected `tablePrefix`,
   host/tenant scopes and all independent host+EI worker processes. Record
   the operator's approved target candidate, maintenance window, and a
   separate rollback destination. **Do not run v1 workers against unknown
   older store markers** or assume schema marker v1 means candidate identity.
2. Reconcile all host-owned in-flight external effects and persisted
   `runtimeReceiptId` idempotency records. Quiesce **every** EI writer,
   scheduler, MCP source/ingress consumer, and host wake worker; fence old
   writer credentials/deployments. Confirm no new DB writes during the dump.
   A rolling upgrade with mixed worker versions is **unsupported**.
3. Record source completeness frontiers, unresolved gaps, event source
   checkpoint/cursor revisions, trigger ownership, audit-chain verification,
   terminal wakes and receipt dedup, as far as bounded APIs permit.
   Any unknown provider completeness remains **unknown** after restore.
4. Take a *whole-database*, encrypted, access-controlled, retained **off-host**
   backup under the host/operator's authorization; the public test uses an
   ephemeral local `/tmp` archive instead and therefore **does not certify
   off-host durability**. Never send the archive or credentials to an LLM,
   issue comment or artifact upload. The backup includes all other objects
   in the operator's database, not only the EI tables.

## Clone, validate and release decision

5. With all writers stopped and a qualified operator-controlled connection,
   use PostgreSQL's actual tools, for example:

   ```sh
   # Run with connection details in protected PG* environment variables or
   # a restricted libpq service, NEVER embedding a password in commands.
   pg_dump --format=custom --no-owner --no-privileges \
     --file /secure/ei-v1-full-snapshot.dump
   sha256sum /secure/ei-v1-full-snapshot.dump
   pg_restore --list /secure/ei-v1-full-snapshot.dump

   # After an operator creates a NEW, EMPTY, isolated target database:
   pg_restore --exit-on-error --single-transaction \
     --no-owner --no-privileges --dbname <isolated_target_database> \
     /secure/ei-v1-full-snapshot.dump
   ```

   The example is **not** an automatic deploy script. Use access-separated
   backup and restore roles. `pg_dump` includes every table and sequence;
   do not filter only the known five EI tables in the **full-database** path.
   Check archive integrity/size/hash and the actual PostgreSQL catalog
   **before** EI initialization could create missing empty objects.
6. In the fully isolated target, perform **cold** SDK initialization under
   the exact candidate version. Unknown physical schema, missing Pattern
   signature on populated state or mismatched signature **must fail closed**.
   Never manually edit a marker to make an incompatible candidate boot.
   There is **no automatic legacy reader or transactional old-state
   conversion**. If incompatible, STOP: retain the source+backup and select
   an explicitly approved *fresh-store reset plus trigger recreation and
   authoritative source replay*, or remain on the last compatible binary.
7. Verify per-tenant owner separation (including two tenants using the same
   logical trigger ID), paused/active lifecycle, audit verification,
   source occurrence dedup and archive head, original cursor and unresolved
   gap revision, revoked MCP connection epoch tombstones, and delivered
   `runtimeReceiptId`. A delivered wake must remain unclaimable after
   recovery. Reconstruct any *host-owned* continuation and receipt store
   separately; EI cannot guarantee another application's DB was backed up.
   The final host must reauthorize work at actual effect execution.
8. Only after a documented operator and host authorization, switch the
   traffic to the validated clone, preventing the old writers from returning.
   Preserve the original DB and archive as a fenced rollback candidate.
   Never claim exact-once remote API behavior based on restored EI state.

## Rejection, failed cutover, rollback

9. On restore error, failed catalog inspection, unknown marker, receipt loss,
   audit mismatch, stale or missing cursor, cross-tenant leak, or an unresolved
   provider gap that cannot be reconciled: **NO CUTOVER**. Do not reset the
   original source. Restore the same immutable backup to a **new empty**
   rollback DB and cold-validate again, or deliberately re-enable the old
   compatible binary against the unchanged original source after fencing
   the candidate. Do not open both on the same writable state.
10. After any rollback, reconcile host effects independently: a remote effect
    committed during the backup/cutover window but not durably acknowledged
    by EI can be retried. Only host-owned effect idempotency makes replay safe.
    Record the source/target hashes, evidence and operator decision.

## Executed scope and unverified claims

The real-PG16 test uses **three randomly named isolated databases**:
quiesced full-source snapshot -> first independent cold clone -> deliberate
signature corruption and refused new startup **without receipt deletion** ->
restore the same SHA-256-pinned archive to a second clean rollback database,
then cold-validate the unchanged original DB. It also checks catalog,
owned trigger state in two tenants, host wake receipt/no redispatch,
provider-gap cursor and revocation persistence, hash-chained source history
and audit. It never touches a production database and cleans all three
fixtures afterward.

This validates **bounded SDK-stored-state upgrade/rollback semantics and
repeatable operator instructions**. It does **not** claim real production
off-host backup, primary failover, PITR/WAL restore, live traffic drain,
end-to-end host side-effect reconciliation, a complete external-provider
source replay, enterprise SLO/RPO/RTO, or independent human security
certification. Those are external optional deployment gates #317/#376.
