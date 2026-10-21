# PostgreSQL scoped terminal history retention sweep — #47

**Status:** Actual operator-controlled bounded deletion of redundant terminal
match/wake *history snapshots* only. This is not full event/match/audit TTL
and does not by itself satisfy #47's remaining retention acceptance.

## Operator contract

```js
const plan = await tenantStore.compactScopedTerminalHistoryBatch({
  kind: 'trigger_match_history',
  before: '2026-10-10T00:00:00Z',
  maxKeys: 10,
  maxRows: 100,
  dryRun: true,
});
const execution = await tenantStore.compactScopedTerminalHistoryBatch({
  kind: 'trigger_match_history',
  before: '2026-10-10T00:00:00Z',
  maxKeys: 10, maxRows: 100, dryRun: false,
});
```

Run separately with `kind: 'wake'` to compact duplicate delivered wake
history. **There is no background TTL job**. Operator must explicitly choose
scope/tenant store, cutoff, kind and `dryRun:false`. The keys scan advances via `nextAfterKey` (pass it as `afterKey` on
subsequent pages). If an individual key reaches `maxRows`, it is
returned as `cappedKey` with `hasMore: true`, and `nextAfterKey` remains
**before that key**: the next call must revisit it until no more interior
duplicates are eligible. Dry-run preview does not drain capped keys.
No more than 32 history keys are processed per page, and **maxRows**
(default 100, up to 1000) limits the eligible duplicate candidates deleted
*per key*. The underlying LAG/LEAD query may inspect **maxHistoryRows**
revisions per key (default 10,000, configurable up to 100,000) while holding
the per-key writer fence; the PostgreSQL statement timeout bounds its physical
execution. **Do not confuse the 1000 deletion limit with a 1000-row scan
limit** when sizing maintenance windows.

The outer scan does not grant permission to delete: each candidate executes
the already-reviewed transactional per-key compactor and rechecks the
authoritative `trigger_match` state is `fired` or the authoritative
`wake_delivery` status is `delivered` with a valid host receipt. The
existing per-key advisory writer fence, strict history budget, past
cutoff and adjacency checks still apply. **Only INTERIOR duplicate revisions
in runs of identical JSON snapshots** can be deleted. The first and last
revision of each run and each transition remain. The source occurrence
stream, event-ID dedup keys, audit chain, current match records, delivery
receipts, **wake keys that remain pending/dead-letter** are NEVER compacted by
this method. A wake which is *now durably delivered* may have accumulated
older duplicate `queued` revisions; this operation can delete their
**interior exact duplicates**, keeping the first and last witness of the
queued phase and every distinct status transition. It therefore does not
promise to preserve every original queued snapshot byte-for-byte.

Each key is one transaction. A failed later key may leave earlier keys
already compacted. The method throws the original fail-closed SQL/policy
error with `error.partialProgress` containing `nextAfterKey`, `failedKey`,
`rows`, and committed `deleted` count. Never interpret the thrown batch as
a rollback or a success. Resume from that last successful cursor after
addressing the failed key; previously processed keys remain idempotent. A scan cannot be interpreted as a consistent,
point-in-time snapshot of all keys, and new keys below the cursor may require
another complete sweep. Do not schedule this automatically without a
separate operator lifecycle policy and reviewed monitoring.

## Evidence

`test/postgres-terminal-retention-sweep.test.mjs` runs with real
PostgreSQL 16 across two physical connection pools and two independent
tenants. It tests dry-run preview and bounded cursor paging, actual duplicate
deletions, cross-pool retries, active match / unreceipted wake exclusion,
durable receipts, no delivered redispatch, unchanged original MCP
occurrences/dedup checkpoint, unchanged audit chain and tenant isolation.
The test runs under `npm run test:postgres`.

This is measurable real storage compaction, but does **not** supply source
event TTL, audit-prefix archival, immutable off-host proof, replay low-water
marks, post-prune audit continuation or a production-scale retention
lifecycle. The parent issue's full retention box stays unchecked.
