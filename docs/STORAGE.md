# Storage and shared-state contract

Event Intelligence separates **reference persistence** from **shared production state**.

The bundled `PersistentEventStore` is a zero-dependency, single-process JSONL backend. The optional `PostgresEventStore` is the production shared-state adapter for horizontally scaled workers.

## Capabilities

Hosts can inspect:

```js
const host = await createEventIntelligenceHost();
console.log(host.storeCapabilities);
```

A backend reports:

- `sharedState`
- `scopeIsolation`
- `wakeClaims`
- `partitionLeases`
- `mutableCompaction`
- `readModel`

A horizontally scaled backend is considered ready only when it declares:

```text
sharedState      = strong
scopeIsolation   = strong
wakeClaims       = distributed-atomic
partitionLeases  = distributed-atomic
```

and implements claim/renew/release partition leases.

## Fail-closed HA mode

Set:

```bash
EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE=true
EVENT_INTELLIGENCE_WORKER_ID=<globally-unique-worker-id>
```

The runtime refuses to start when the configured store does not satisfy the shared-state contract or when a worker id is missing. The default JSONL store therefore cannot accidentally be deployed as if it were HA.

For Pattern AST v2, a store advertising distributed partition leases is used before mutating a trigger/version/partition buffer. Lease contention is explicit instead of allowing concurrent workers to mutate the same CEP partition.

## PostgreSQL shared state

Install the PostgreSQL driver in the host application and pass its pool into EI:

```bash
npm install pg
```

```js
import pg from 'pg';
import {
  createEventIntelligenceHost,
} from 'mcp-event-intelligence/host';
import {
  PostgresEventStore,
} from 'mcp-event-intelligence/storage/postgres';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const store = new PostgresEventStore({
  pool,
  ownsPool: true,
});

const ei = await createEventIntelligenceHost({
  store,
  env: {
    EVENT_INTELLIGENCE_REQUIRE_SHARED_STORE: 'true',
    EVENT_INTELLIGENCE_WORKER_ID: process.env.INSTANCE_ID,
  },
  mcpRegistry,
  wake,
});
```

The adapter accepts a `pg`-compatible pool instead of importing a SQL driver itself. PostgreSQL therefore remains optional for single-process/reference deployments and the embedding host retains database connection, credential and lifecycle ownership.

The adapter stores current state, append-only history, counters and leases in database tables under a configurable prefix.

**Prefix validation:** PostgreSQL normally limits identifiers to 63 bytes,
including generated suffixes such as `_history_scope_kind_idx`. EI now rejects
`tablePrefix` longer than `MAX_POSTGRES_TABLE_PREFIX_BYTES` (40 ASCII bytes)
at construction with `EVENT_INTELLIGENCE_POSTGRES_PREFIX_TOO_LONG`.
This avoids silent truncation of index/table names and possible collisions
between installations. Existing deployments with overlong table prefixes must
choose an operator-controlled migration/rename with a verified backup; EI
does not silently point at a truncated old relation. This is an intentional
pre-v1 fail-closed constraint, not an automatic schema migration. Every primary key/query includes `scope_id`, so tenant/workspace isolation is enforced in the storage keyspace rather than by filtering a global in-memory result after the query.

Authoritative PostgreSQL state includes:

- trigger definitions and lifecycle state;
- Pattern v2 buffers/matches and match history;
- event-source metadata and MCP cursor/subscription state;
- deduplicated MCP event occurrences;
- temporal deadlines;
- derived contracts and derived events;
- durable semantic decisions;
- wakes and wake-delivery state;
- hash-linked audit history;
- trigger/version/partition leases.

### Persisted schema contract and deliberate upgrade

The PostgreSQL adapter now records `POSTGRES_PERSISTED_SCHEMA_VERSION = 1` in a dedicated `<tablePrefix>_metadata` table under the existing transactional schema-advisory lock. Multiple workers starting simultaneously must observe the same committed marker. Empty stores receive v1 automatically; already-versioned v1 stores reopen normally.

**Fail closed:** an unknown or newer marker blocks startup with `EVENT_INTELLIGENCE_POSTGRES_SCHEMA_INCOMPATIBLE`. A nonempty, **unversioned** pre-marker database blocks with `EVENT_INTELLIGENCE_POSTGRES_SCHEMA_UNVERSIONED`; no stored triggers, receipts, cursors or evidence are deleted or implicitly migrated. The refused initialization is rolled back.

**Operator procedure for an existing pre-marker PostgreSQL database:**

1. Stop all EI workers sharing the table prefix and verify the running package/database version.
2. Take and **verify a restorable backup/snapshot** of all EI tables (including records, history, leases and counters). Check any applicable retention/audit requirements.
3. Confirm the existing tables were created by the earlier EI PostgreSQL adapter with the expected v1 column definitions; this first slice **does not structurally certify legacy tables**.
4. Run a single maintenance bootstrap using `new PostgresEventStore({pool, tablePrefix, adoptUnversionedSchema: true}).init()`. This is a one-time explicit adoption flag; the store records `adopted_from = 'unversioned-explicit'`.
5. Remove the opt-in flag, resume workers and verify scope counts, trigger states, receipts and wake reconciliation.

This is a controlled **adoption**, not an automatic data migration. It must not be used to relabel a genuinely incompatible custom schema. Future breaking migrations require separately designed and tested transitions, not modifying this marker by hand. The host remains responsible for snapshot consistency and disaster-recovery practice. Also see [#47](https://github.com/sarooo17/event-intelligence/issues/47) and [#50](https://github.com/sarooo17/event-intelligence/issues/50).

### Distributed atomicity

Wake ownership is claimed inside a database transaction with a row lock. A claim records the worker id, attempt count and lease expiry. Another worker cannot claim the same wake until the lease expires; a stale worker cannot later complete or fail a claim it no longer owns.

Pattern partitions use an atomic PostgreSQL lease keyed by `triggerId:version:partitionKey`. Claim/reclaim is one `INSERT ... ON CONFLICT ... WHERE` operation, with owner-checked renew/release.

For state whose row may not exist yet, such as the first lifecycle mutation, MCP occurrence deduplication or the next audit-chain record, the adapter uses transaction-scoped advisory locks. This closes the first-writer race that a row-level `FOR UPDATE` alone cannot protect.

The audit chain is serialized per EI scope, so concurrent workers still produce one monotonic sequence and one valid hash chain.

### Wake claim-generation fencing

Each `claimWakeDelivery` increments the persisted, per-wake `attemptCount`.
The same numeric attempt generation **must** be presented with `workerId`
to `completeWakeDelivery` and `failWakeDelivery`, and is checked under the
same atomic transaction/serialized JSONL update as the delivery status.
Missing generations fail with `WAKE_DELIVERY_CLAIM_GENERATION_REQUIRED`;
stale generations fail with `WAKE_DELIVERY_CLAIM_LOST`.

This closes the **same-worker ABA** gap: a worker process may reclaim its own
expired lease before its previous delivery attempt returns. The old attempt
cannot complete the new claim or schedule a retry/dead-letter with stale state,
even though both attempts have the same `workerId`. No schema migration is
needed because `attemptCount` was already persisted before this change.
The coordinator now forwards the generation from each claim to both terminal
store operations. If its callback loses ownership while in flight, it returns a
non-terminal `claim_lost` outcome (with current delivery state) instead of
scheduling a retry/dead-letter for the successor or throwing out of the
retry scheduler. This is a deliberate pre-v1 change to the advanced store
mutation contract; custom adapters must follow the same generation fencing.

**Important limitation:** state fencing does not prevent the external runtime
from receiving an event twice if a lease expires during its side effect.
Hosts must still make delivery idempotent using the stable EI wake/host receipt
identity; the fence protects durable EI state transitions, not arbitrary
external actions.

### Crash and retry recovery

Wake retry/DLQ state is shared database state. If a worker disappears after claiming a wake, another worker can reclaim it after `leaseUntil`. Retry attempt count, next attempt time and dead-letter state remain visible to every worker.

A completed runtime receipt is also persistent. On restart, the existing EI wake reconciliation path can finalize the wake/match without invoking the external deliverer again.

Partition leases use the same expiry model: ownership can move to another worker after expiry, allowing a crashed CEP worker's partition to recover.

### Bounded match-history reads

Both bundled stores expose a new opt-in read API:

```js
const { records, hasMore, limit } =
  await store.getRecentTriggerMatchHistory(matchId, { limit: 100 });
```

The method accepts integer limits from 1 to 500 and returns records in chronological order **within the most recent window**, plus `hasMore` to signal omitted older revisions.

In PostgreSQL, this is an indexed, scope-constrained `ORDER BY history_id DESC LIMIT limit+1` query; it does not first load the entire append-only history. In the JSONL reference store, it slices the in-process materialized revision list after filtering by match ID, so it cannot claim disk paging or HA behavior. PostgreSQL and JSONL preserve the same returned contract.

This API deliberately does not change the existing `listTriggerMatchHistory` semantics, so callers requiring a complete history receive it until they opt into a bounded view. Never assume a window with `hasMore: true` is a complete audit record.

## Reference JSONL store

`PersistentEventStore` remains the zero-dependency default. It publishes process-atomic wake/partition leases and physically namespaces non-default scopes, but it is **not** a multi-replica database.

`PersistentEventStore.compactMutableState()` atomically rewrites only current mutable snapshots:

- wake deliveries;
- trigger states;
- event sources;
- MCP client cursors/state;
- temporal deadlines;
- derived contracts;
- semantic decision cache;
- active partition leases.

It does **not** discard append-only evidence, audit history, event occurrences, trigger definitions, derived events, wakes or trigger-match history.

## Conformance and HA verification

Custom adapters can use:

```js
import {
  runStoreConformance,
} from './scripts/lib/store-conformance.mjs';
```

The generic harness verifies state round-trip, wake-claim exclusion, partition-lease exclusion when supported, compaction when supported and shared-capability declarations.

The PostgreSQL adapter is additionally gated in CI against a real PostgreSQL 16 service. The HA suite opens independent connection pools to simulate independent workers and verifies:

- shared-store conformance with `expectShared: true`;
- startup with fail-closed shared-store mode;
- one winner under concurrent wake delivery;
- wake-lease expiry takeover and stale-owner rejection;
- retry state and DLQ visibility across workers;
- partition-lease contention and expiry recovery;
- scope isolation;
- a valid ordered audit chain under concurrent writers.

This is the evidence used to advertise the Postgres adapter's strong shared-state capabilities.
