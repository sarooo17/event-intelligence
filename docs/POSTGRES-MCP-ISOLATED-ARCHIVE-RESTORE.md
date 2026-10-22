# Recover archived MCP source records into isolated PostgreSQL (#47)

**Recovery evidence, NOT production cutover, source/audit pruning, off-host
WORM or permission to dispatch restored records to an agent.**

The source archive bundle (merged #252/#257) already provides lossless,
externally checkpoint-authenticated pages for MCP event occurrences.
Previously it allowed *offline reading only*: after losing the database,
operators could not reconstruct the original source counter and dedup index
for independent PostgreSQL inspection. The new
`mcp-event-intelligence/storage/postgres/restore` entrypoint adds a
transactional **source-only restore** into a separate, empty, explicitly
operator-confirmed PostgreSQL table prefix:

```js
import {PostgresEventStore} from 'mcp-event-intelligence/storage/postgres';
import {restoreMcpOccurrenceArchiveToIsolatedPostgres} from
  'mcp-event-intelligence/storage/postgres/restore';

const isolated = new PostgresEventStore({
  pool: dedicatedRecoveryPool, // deliberately provisioned EMPTY PG16 instance
  tablePrefix: 'ei_restore_unique_case_name', // mandatory restore-only prefix
  scopeId: trustedCheckpoint.scopeId,
  dispatchPoolIdentity: dedicatedRecoveryPool,
});
await isolated.init();

const receipt = await restoreMcpOccurrenceArchiveToIsolatedPostgres(isolated,{
  archive: verifiedSourceArchive,
  trustedCheckpoint, // authenticated separately, NOT read from the file itself
  confirmIsolatedRestore:'RESTORE_VERIFIED_SOURCE_TO_ISOLATED_EMPTY_POSTGRES',
});
```

**Safety conditions:**
- The source archive's **entire** hash chain, exact tenant scope, ordering,
  genesis, head and independently pinned checkpoint must verify before
  touching the database. At most 10,000 occurrences; operator can request
  a lower cap. No partial replay window can act as a complete restore.
- The target store must be initialized at a distinct operator-controlled
  prefix starting with `ei_restore_`. Under transactional table locks,
  **all** record, history, counter and lease tables must be empty, including
  rows owned by other tenants. Already used and ambiguous targets fail
  closed, without overwriting or dropping any rows.
- Source occurrence history, matching `mcp_occurrence_key` dedup rows and
  the original durable source counter are written atomically; an injected
  mid-stream database failure rolls back **every** row. Two concurrent
  restoration attempts cannot both complete.
- Every archived original PostgreSQL `JSONB::text` value is inserted as
  `::jsonb` and compared to `RETURNING payload::text` in the same
  transaction: no JavaScript numeric roundtrip of large/high-precision
  provider payloads. Exact provider source identities are checked.
- The restoration call writes **no** triggers, match states, leases, pending
  wakes, host delivery receipts, audit entries or live MCP subscriptions.
  It does **not** invoke Pattern, poll providers, call hosts or change
  the original store. Its result explicitly indicates zero host effects
  and `productionCutoverAuthorized: false`.

The regression
`test/postgres-mcp-isolated-archive-restore.test.mjs` uses real
PostgreSQL16 independent pools, a verified source archive with an actual
`9007199254740993` JSONB integer (not exactly representable in JS),
source replay/duplicate detection after restoration, preserved foreign
tenants, an injected PostgreSQL CHECK failure after earlier rows have
inserted (full rollback), two simultaneous competing restorers and a
nonempty other-tenant target rejection.

**Still required for complete retention:** an independently immutable
off-host archive and retained signature/checkpoint; a durable replay
low-watermark tied to opaque provider subscription cursors; audit-chain
prefix continuation; restoration of subscription/Pattern/CEP/wake and host
idempotency state; fault-injected cutover tests and operator-authorized
physical pruning. This isolated drill proves source history and dedup are
restorable without data loss, but it must **never** be attached to a live
host before those additional conditions are implemented and reviewed.
