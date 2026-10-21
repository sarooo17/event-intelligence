# PostgreSQL MCP source-occurrence archive proof — non-destructive prerequisite (#47)

**Status: SAFE EXPORT ONLY; NOT source-event TTL or production retention signoff.**
This adds a bounded, operator-invoked snapshot/export path for the original
`mcp_occurrence` history. It changes no schema, default ingestion behavior,
host delivery, agent tools or persisted retention rules. No deletion runs.

## Why deletion remains forbidden

Each stored MCP occurrence currently has an authoritative
`mcp_occurrence_key` record (for replay dedup) and an append-only
`mcp_occurrence` history row (for replay inspection). Removing either without
an explicit provider replay floor and preserved durable wake/host receipt
identity can create duplicate effects or erase unmatched source evidence.
Opaque MCP cursors do **not** establish a numeric replay floor, and
unresolved truncated-history gaps, queued CEP windows or pending wake retries
cannot be assumed safe based on event age alone. Separately, deleting the
prefix of a genesis-linked audit chain breaks `appendAudit` and
`verifyAudit()`. Do not introduce a general TTL job on these tables.

## Snapshot and proof contract

1. `getMcpOccurrenceArchiveCheckpoint({maxOccurrences:10000,maxScanMs:5000})`
   acquires a scope-local PostgreSQL advisory transaction fence shared with
   **every** MCP append (before even the first sequence row can be inserted),
   then locks the sequence counter row and scans up to 10000 occurrences and verifies
   contiguous 1-based sequence numbers. Any missing, malformed, reordered or
   excessive history fails closed. Every record participates in a
   domain-separated, scope-bound SHA-256 hash chain over **raw PostgreSQL\n   `JSONB::text`** rather than parsed JavaScript values, beginning
   with a deterministic scoped genesis. The returned checkpoint contains
   `schema`, `scopeId`, `genesisHash`, `endSequence`, and `headHash`.
   This operation is **O(N)**, deliberately limited and operator-only; large
   installations must use another reviewed export design before attempting
   to archive all data.
2. **Independently authenticate and pin** this entire checkpoint outside
   the PostgreSQL instance (e.g. a signed off-host WORM manifest). A new
   checkpoint read from the same possibly compromised database is NOT a
   trust root.
3. Call `getMcpOccurrenceArchiveWindow({checkpoint,afterSequence:0,limit:100})`.
   Pages are at most 1000 records, use the original source payloads, and
   provide `previousHash`, `headHash`, and `hasMore`. All pages from
   sequence 1 through the trusted terminal hash must be collected. For
   subsequent pages, pass the preceding *independently verified* page's
   `endSequence` and `headHash`. A zero-record checkpoint has a valid
   empty proof.
4. Outside the store, run `verifyMcpOccurrenceArchiveWindow(proof,{
   trustedCheckpoint,trustedAfterSequence,trustedPreviousHash,trustedLimit})`
   for every page, starting with the externally pinned genesis hash. The
   verifier rejects missing/reordered sequences, payload edits, forged scope,
   wrong predecessor or terminal hash, hidden tail and false `hasMore`.
   Validation of a **non-final** page alone cannot prove that the rest of
   the exported archive exists: only full chained verification ending at
   the pinned terminal commitment completes the export.
5. Keep independent source/archive restore and lifecycle evidence. These
   helpers do not authenticate the operator, sign an archive, guarantee off-host
   persistence, bind an opaque provider cursor to a numeric replay floor, or
   delete any historical row/dedup key/receipt/audit chain.

## Operational limits and regression

Both PostgreSQL methods impose a configurable 100–30000ms per-SQL-statement
`statement_timeout`; a 10k-row checkpoint can still be expensive.
Archive windows are read-only and use a bounded `OFFSET` query against
the per-scope index; this is a **bounded predecessor step**, not a
high-cardinality streaming exporter or predictable production I/O SLO.
The record hash proof covers source history, not complete CEP derived buffers,
trigger match history, wake receipts or audit. An archived source snapshot is
not an authorization to prune those separate stores.

`test/mcp-occurrence-archive.test.mjs` exercises the independent hash proof,
tampering, swapped tenants, omitted pages and checkpoint truncation without PG.
`test/postgres-mcp-occurrence-archive.test.mjs` runs on real PostgreSQL 16:
independent connection pools, event replay, source cursor durability,
audit continuity, scope isolation, a frozen checkpoint after new writes,
operator scan budgets and direct stored-history corruption. Both tests leave
source occurrence history and dedup keys intact.

**#47 remains open.** Full retention acceptance requires an independently
pinned external archive, replay floor for each source/subscription including
unresolved delivery gaps, long-lived CEP/pending-work protection, safe
post-prune hash-chain continuation, crash/recovery/fencing and measured
storage/latency proof at production workload scales.

**Additional PG16 fault regressions:**
`test/postgres-mcp-archive-lock-precision.test.mjs` pauses a real writer
*after incrementing the transactional sequence counter but before appending
its history*, proves the independent snapshot waits at the advisory fence\n(and then reads the complete committed history),
then resumes and validates a contiguous archive. It also changes a retained
JSONB numeric value from `9007199254740992` to `9007199254740993`:
JavaScript numeric decoding sees the same value, but the **raw JSONB text
commitment rejects the tamper**. The full MCP occurrence schema is checked
before producing any checkpoint or page.
