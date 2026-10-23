# MCP source replay retention fence (PostgreSQL) — #47

**Shipped behavior when this change merges:** An EI consumer can no longer
receive an apparently successful partial occurrence replay when the
PostgreSQL historical source stream or its durable dedup keys have
been accidentally deleted, truncated or corrupted.

The previously permissive `listMcpOccurrencesAfter(sequence)` filtered
the available rows, sorted them and returned whatever remained. An unsafe
future TTL implementation could silently omit events at or before the
client's requested sequence; the consumer would never know it had lost
evidence. A lost `mcp_occurrence_key` dedup record could also permit a
replayed provider event to be appended again as a new occurrence.

The new replay operation:
1. Rejects negative, fractional, non-numeric and beyond-head replay
   sequences, instead of silently reporting an empty successful result.
2. Reads the durable counter, historical rows and dedup keys under a
   single **READ ONLY, REPEATABLE READ PostgreSQL MVCC snapshot**. Source
   append commits its sequence, dedup key and history row together in one
   transaction, so the reader sees all or none of a concurrent insert.
   The replay reader **does not take the writer advisory lock**, avoiding
   blocking live provider ingestion during a long historical scan.
3. Requires **all original** history sequences from 1 through the
   authoritative source counter, exactly once and in physical append order.
4. Requires each historical source's original dedup key to exist, to
   reference the same sequence, server, subscription and **complete
   original PostgreSQL JSONB::text** payload (not just its event ID).
   Text is compared BEFORE parsing to JavaScript, so numerically
   different original integers such as 9007199254740992 and
   9007199254740993 cannot collide. Rejects missing, forged,
   altered-payload and unaccounted dedup entries.
5. Returns only the requested suffix **after** verifying the entire
   source and dedup invariants; there is no partial successful result.

Inconsistent state throws
`EVENT_INTELLIGENCE_MCP_REPLAY_HISTORY_GAP`; a nonsensical replay cursor
throws `EVENT_INTELLIGENCE_MCP_REPLAY_CURSOR_INVALID`. Both errors
must be handled by consumers as a safety failure, not an empty poll.
No source, dedup record, audit record, checkpoint or wake receipt is
deleted, and no automatic retention lifecycle is enabled.

This is an intentionally **strict pre-retention invariant**. It scans
the tenant's full occurrence stream and dedup index inside a consistent
read-only MVCC snapshot (without the writer fence), and may be costly on
large source histories. Before
enabling production-scale archival compaction, this must be replaced
with a bounded, explicitly durable **replay floor**, independently
authenticated off-host archive and verified restoration semantics.
Removing any historical occurrence today is supposed to stop normal
replay, including when a consumer requests only later data. That
fail-closed behavior is safer than silently losing events but is not
the final post-compaction design.

The actual PG16 regression runs independent workers/connection pools
against multiple tenants and physically deletes an interior source row,
a durable dedup row and tampers with historical sequence JSONB. It
proves malformed replays fail closed, a legitimately advanced cursor
cannot hide old pruning, and an unaffected tenant continues to replay.

**Not accomplished:** archive-backed playback for pruned history,
physical source deletion, durable per-source opaque-cursor watermarks,
off-host WORM, audit-chain pruning or production throughput SLO.
The inherited full #21/#47 retention checkbox remains unchecked.

## Independently verified offline replay from a previously pinned archive

The same PR adds a complementary **operator-controlled, bounded raw replay**
of a verified snapshot made by the existing local archive bundle export:

```js
import {
  readMcpOccurrenceArchiveReplayWindow,
} from 'mcp-event-intelligence/storage/postgres/archive';

const result=readMcpOccurrenceArchiveReplayWindow(
  JSON.parse(archivedFileBytes.toString('utf8')),{
    trustedCheckpoint, // independently known; NEVER trust the file's copy
    afterSequence:2,limit:100,
  },
);
for(const record of result.records){
  // Exact original PG JSONB::text, including decimal numeric lexemes.
  const originalSourcePayloadText=record.rawPayloadJson;
}
```

The call authenticates the **entire complete archived prefix**, including
scope/sequence/hash links, before exposing any source record. It then
returns a bounded contiguous window by logical source sequence and a
hasMore flag. A missing page, switched tenant, untrusted checkpoint, bad
limit or cursor is rejected without returning partial data. Records are
exposed as **raw JSONB source text**, not a JavaScript Number-decoded
event; a future host restore adapter must use an explicitly reviewed
exact-numeric conversion policy instead of silently rounding large
PostgreSQL numeric values.

This capability is **offline only** and never bypasses the live PostgreSQL
fail-closed reader. It proves an authenticated archived occurrence can
still be read after tampering with the original live DB, as tested with
real PostgreSQL 16. It is **not** a complete runtime restoration:
subscription opaque cursors, active Pattern/CEP state, wake receipts and
exactly-once host effects still require a separately designed atomic
cutover, off-host immutable evidence and replay-floor protocol. No TTL
is enabled and no physical deletion is authorized.

## Additional fail-closed numeric replay policy (October 23, 2026)

The historical event and dedup rows may be **identical** in PostgreSQL
`JSONB::text` yet carry an integer or high-precision decimal that
`JSON.parse` silently rounds before EI returns the event to an agent.
For example, a real PostgreSQL source amount `9007199254740993`
would become the JavaScript Number `9007199254740992` despite a
successful raw history/dedup comparison. Before decoding each persisted
source occurrence, `listMcpOccurrencesAfter()` now applies the same
strict numeric-precision preflight already used by the audit chain. Such
unsafe payloads fail closed with
`EVENT_INTELLIGENCE_MCP_REPLAY_HISTORY_GAP`; no rounded event data is
returned, even when the cursor requests only later events. The real PG16
regression mutates *both* source history and dedup to the same exact unsafe
numeric lexeme and confirms replay refuses it.

This is an intentional safety restriction until a precision-aware live
source representation is supported. Operators/providers should encode
amounts requiring exactness as validated decimal strings. This change
does **not** introduce an archive-backed replay floor or authorize
removing any history. It adds no persisted schema migration.
