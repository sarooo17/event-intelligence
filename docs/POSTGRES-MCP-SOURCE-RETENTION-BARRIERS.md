# PostgreSQL source retention preflight inventory — #47

**Status: non-destructive operator diagnostics. NEVER a replay-floor certification or permission to prune.**

Before implementing source-event TTL, EI must protect both its numeric
`mcp_occurrence` sequence and each independent provider/subscription's opaque
cursor and completeness revision. A provider opaque cursor **cannot** be
arithmetically compared with the EI occurrence counter, and a healthy poll
after an earlier truncated page does not prove recovered delivery history.
An offline source archive, even with a signed witness, also does not
guarantee a live worker can replay a deleted source event.

## Operator API

```js
const report = await postgresEventStore.inspectMcpSourceRetentionBarriers({
  maxSources: 1024, maxScanMs: 5000,
});
console.log(report.schema, report.scopeId, report.sourceTailSequence);
console.log(report.blockers);
// ALWAYS false: no source, dedup, audit, wake or CEP data can be pruned.
if (report.physicalSourcePruneAuthorized) throw Error('Unexpected unsafe signoff');
```

The method:
- Acquires the same scoped `mcp-gap-fence` as client state writes, then the
  scoped `mcp-archive-sequence` fence as source occurrence appends. During
  the read it has a coherent, serialized view of source client revisions and
  the durable EI source counter. The locks release **before** returning:
  an old report is not a concurrent prune authorization.
- Uses bounded indexed SQL, max 16,384 client states, an **8 MiB total**
  serialized client-state/key budget and 30s statement timeout. An aggregate
  PostgreSQL-side size check runs **before** transferring or parsing JSONB;
  individual persistent state payloads are capped at 16 KiB of actual
  PostgreSQL `JSONB::text` (not compact `JSON.stringify` and not TOAST
  compressed bytes) and keys at 8 KiB. New writes fail closed, including
  canonical whitespace expansion; legacy oversized rows block inspection.
  Invalid or lossy records are rejected rather than truncated.
- Returns a reproducible SHA-256 digest bound to tenant and observed state,
  per-source opaque-cursor *hashes* and completeness revisions, never raw
  provider tokens or subscription argument bodies.
- Recomputes and verifies each persisted client-state identity key from the
  actual connection ID, event name and canonical safe JSON arguments; rows
  whose stored key does not match their payload fail closed. Persisted
  `gapUnresolved` and optional `truncated` must be real booleans;
  malformed values never masquerade as complete delivery.
- Reports observed unresolved gaps (`gapUnresolved` or `truncated`),
  missing cursors and missing source inventory; **always** reports
  unverified provider cursor→source sequence proof, externally immutable
  source+audit evidence, pending CEP/wake/dedup lifecycles and audit-prefix
  hash continuation.

`physicalSourcePruneAuthorized` and
`productionReplayFloorEstablished` are hardcoded **false**. This report is
not itself a durable trusted checkpoint or cryptographic signature; the
digest is only an integrity aid for comparing snapshots. A hypothetical
future operator prune must have its own independently verified,
atomic/locked replay-floor and audit/wake guards **in the same transaction as
any deletion**, not re-use this stale report as an approval token.

## PostgreSQL acceptance

`test/postgres-retention-source-inventory.test.mjs` runs against PostgreSQL
16 with independent pools and tenants. It verifies sticky provider delivery
gaps, revision changes, non-exposure of opaque cursor values, scope separation,
bounded inspection, unsafe-number refusal and unchanged source replay/dedup.
It is part of `npm run test:postgres`.

**Compatibility:** an additive read-only method and declaration, plus a
pre-v1 fail-closed durable provider-state byte policy (16 KiB payload,
8 KiB key). Hosts with extraordinarily large opaque cursors/arguments
must reject or redesign that source representation; existing oversized
legacy rows block operator inspection rather than being silently skipped.
No new tables/indexes, migration, provider transport changes, background
work, MCP tools, WORM uploads, production SLO or physical TTL. #47 and all
transferred #21 unresolved items remain open.
