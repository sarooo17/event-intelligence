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
- Uses bounded indexed SQL, max 16,384 client states and 30s SQL timeout;
  rejects over-budget, invalid or lossy persisted states rather than
  truncating an operator report.
- Returns a reproducible SHA-256 digest bound to tenant and observed state,
  per-source opaque-cursor *hashes* and completeness revisions, never raw
  provider tokens or subscription argument bodies.
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

**Compatibility:** only an additive read-only method and declaration.
No new tables/indexes, migration, provider transport changes, background
work, MCP tools, WORM uploads, production SLO or physical TTL. #47 and all
transferred #21 unresolved items remain open.
