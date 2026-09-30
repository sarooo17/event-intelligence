# Storage and shared-state contract

Event Intelligence separates **reference persistence** from **shared production state**.

The bundled `PersistentEventStore` is intentionally a single-process, zero-dependency backend. It now publishes explicit capabilities, process-atomic partition/wake leases, and atomic compaction for mutable snapshot logs. It is still **not** a multi-replica database.

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

The runtime refuses to start if the configured store does not satisfy the shared-state contract. The default JSONL store therefore cannot accidentally be deployed as if it were HA.

For Pattern AST v2, a store that advertises distributed partition leases is used by the engine before mutating a trigger/version/partition buffer. Lease contention returns an explicit error instead of allowing concurrent workers to mutate the same CEP partition.

## Reference-store compaction

`PersistentEventStore.compactMutableState()` atomically rewrites only current mutable snapshots:

- wake deliveries
- trigger states
- event sources
- MCP client cursors/state
- temporal deadlines
- derived contracts
- active partition leases

It does **not** discard append-only evidence, audit history, event occurrences, trigger definitions, derived events, wakes, or trigger-match history.

## Adapter conformance

Custom adapters can use:

```js
import {
  runStoreConformance,
} from './scripts/lib/store-conformance.mjs';
```

The harness verifies state round-trip, wake-claim exclusion, partition-lease exclusion when supported, compaction when supported, and shared-capability declarations.

## Why there is no fake Postgres adapter yet

The current runtime still exposes several synchronous materialized reads such as `listTriggers()`, `getTriggerState()`, and `listTriggerMatches()`. A real multi-process Postgres backend must not hide network/database reads behind stale process-local caches while claiming strong shared state.

The next storage milestone is therefore an async read-contract migration followed by a transactional Postgres adapter. Until that lands, shared-store mode intentionally fails closed rather than overstating HA guarantees.
