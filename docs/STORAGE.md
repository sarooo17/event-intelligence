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

The adapter stores current state, append-only history, counters and leases in database tables under a configurable prefix. Every primary key/query includes `scope_id`, so tenant/workspace isolation is enforced in the storage keyspace rather than by filtering a global in-memory result after the query.

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

### Distributed atomicity

Wake ownership is claimed inside a database transaction with a row lock. A claim records the worker id, attempt count and lease expiry. Another worker cannot claim the same wake until the lease expires; a stale worker cannot later complete or fail a claim it no longer owns.

Pattern partitions use an atomic PostgreSQL lease keyed by `triggerId:version:partitionKey`. Claim/reclaim is one `INSERT ... ON CONFLICT ... WHERE` operation, with owner-checked renew/release.

For state whose row may not exist yet, such as the first lifecycle mutation, MCP occurrence deduplication or the next audit-chain record, the adapter uses transaction-scoped advisory locks. This closes the first-writer race that a row-level `FOR UPDATE` alone cannot protect.

The audit chain is serialized per EI scope, so concurrent workers still produce one monotonic sequence and one valid hash chain.

### Crash and retry recovery

Wake retry/DLQ state is shared database state. If a worker disappears after claiming a wake, another worker can reclaim it after `leaseUntil`. Retry attempt count, next attempt time and dead-letter state remain visible to every worker.

A completed runtime receipt is also persistent. On restart, the existing EI wake reconciliation path can finalize the wake/match without invoking the external deliverer again.

Partition leases use the same expiry model: ownership can move to another worker after expiry, allowing a crashed CEP worker's partition to recover.

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
