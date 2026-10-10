# PostgreSQL semantic cache retention (opt-in)

This is one bounded **disposable decision-cache** retention slice for #47/#49,
not general event, match, audit, trigger, delivery or dedup retention.

`PostgresEventStore.compactMutableState({ semanticCacheBefore, maxRows })`:
- Defaults to **no deletion** when the host supplies no policy, preserving
  previous behavior.
- Requires an offset-aware ISO timestamp and integer batch bound
  `1 <= maxRows <= 1000` (default 500), otherwise fails without any write with
  `EVENT_INTELLIGENCE_RETENTION_POLICY_INVALID`.
- Deletes at most one batch of *semantic_cache* rows strictly older than
  the cutoff in the **current store scope only**, using a transaction,
  `FOR UPDATE SKIP LOCKED`, and stable `updated_at, record_key` order.
- Reports the number of actual rows deleted and whether the configured
  batch cap was reached. The operator must explicitly repeat bounded batches
  to continue pruning.
- Leaves persisted trigger definitions, match and source occurrence history,
  wake delivery receipts, partition leases, derived-event evidence, and the
  chained append-only audit records **untouched**. A previously cached model
  decision removed by retention can be recomputed using the ordinary
  per-trigger evaluator budget, not fabricated as a match.

Example (on an explicitly isolated host-owned store):

```js
const result = await store.compactMutableState({
  semanticCacheBefore: '2026-10-01T00:00:00.000Z',
  maxRows: 200,
});
if (!result.ok) throw new Error('Cache retention failed');
```

A real PostgreSQL 16 conformance test, `test/postgres-semantic-cache-retention.test.mjs`,
verifies tenant A cannot delete tenant B's cache row (including same logical
cache key), newer decisions survive, historical receipts and audit hash chain
are unaffected, invalid policies fail, concurrency does not double count
deleted rows and a new store sees the persisted outcome.

**Non-goals:** this does not imply retained owner-specific events are safe
to drop; many are required for evidence, wake deduplication, causal lineage,
tenant investigations and audit verification. Deleting even old audit records
would invalidate the current chain without a separately designed checkpoint
contract. No mandatory automatic background sweeper, duplicate scheduler,
model provider, or host permission implementation is introduced.
