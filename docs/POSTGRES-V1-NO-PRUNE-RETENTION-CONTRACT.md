# Event Intelligence SDK v1 — conservative PostgreSQL no-prune retention

**#47 last SDK core acceptance candidate.** This is a deliberate,
**unbounded-growth but lossless** policy, not a claim that physical TTL,
WORM archiving or provider-backed replay low-watermarks are implemented.
The trade-off is explicit: retain provenance, source/dedup and audit until
a separately reviewed post-v1 pruning protocol can prove safe retention.

## Normative v1 contract

- The canonical append-only `mcp_occurrence` stream, its
  `mcp_occurrence_key` dedup identities and scope-local source counter are
  **never pruned by the EI SDK**. Source reads use a single PostgreSQL
  `REPEATABLE READ READ ONLY` snapshot and verify **every sequence from
  genesis**, matching raw PostgreSQL JSONB source/dedup payload and keys.
  Any physical gap, missing dedup or unsafe numeric decoding fails closed
  with `EVENT_INTELLIGENCE_MCP_REPLAY_HISTORY_GAP`, even if a consumer
  tries a cursor *after* the missing event.
- The genesis-linked audit chain is **never pruned by the EI SDK**.
  `getAuditCheckpoint()` validates the complete chain and precision-safe
  raw PostgreSQL JSONB; missing/tampered prefix or inconsistent sequence
  aborts. The SDK may export pinned, optionally signed audit/source
  snapshots, but this does not authorize physical deletion.
- Active/matched Pattern records and all authoritative
  `wake_delivery` receipts **remain durable**. Only independently
  operator-authorized `compactScopedTerminalHistoryBatch` may delete
  *interior identical* history snapshots for **fired matches** or
  **durably delivered wakes** (both transitions and first/last witness
  retained); pending/dead-letter receipts and all source/audit keys remain.
  It is a bounded paginated per-key transactional operation, default
  dry-run; no background automatic compaction.
- Provider opaque cursor, `truncated` and `gapUnresolved` are **not**
  event-time completeness proofs. `inspectMcpSourceRetentionBarriers()`
  reports sources, revisions and gaps and always denies physical pruning
  or a production replay floor. An external source gap remains unknown;
  a valid local source replay does **not** prove that a remote producer
  delivered everything.
- Failed provider replay, source/audit corruption, mismatched historical
  receipt, incorrect snapshot, invalid budget or unsupported physical
  source/audit compaction are **errors**, not permission to skip evidence.

## Operator-only local integrity preflight

The replay and audit-checkpoint store APIs support optional
`{maxScanMs}` (100–30,000 ms) that applies PostgreSQL transaction-local
`statement_timeout` to the **actual** full source/dedup reads and audit
advisory lock/checkpoint query. Legacy callers that omit this option
retain their existing behavior. This is a **per SQL statement** cap,
not one global cumulative wall-clock deadline across all independent
operator preflight reads. Under contention, the preflight must error,
never treat a timed-out scan as success. PG16 tests hold a live
`ACCESS EXCLUSIVE` source-history lock and a separate audit advisory
lock to force these fail-closed timeout paths. A separate real PG16 test
writes oversized source and audit JSONB and verifies that the lower
aggregate byte caps reject those rows without loading them into Node.

The optional, non-published validation module
`scripts/validation/postgres-no-prune-retention-v1.mjs` provides
`verifyPostgresV1NoPruneRetention({store,maxOccurrences,maxAuditRecords,
maxSources,maxScanMs,maxMatchRevisions,maxSourceBytes,maxAuditBytes,matchIds,wakeIds})`.

It checks source-state inventory and the **full local source/dedup
continuity**, source archive checkpoint, genesis-linked audit checkpoint,
with actual PostgreSQL-side aggregate byte checks **before** original source,
dedup or audit JSONB payloads can cross into the Node process. Default
source+dedup cap: **16 MiB**, audit cap: **8 MiB**, operator-configurable
between 1 KiB and 64 MiB; the source archive checkpoint separately
checks source payload byte length under the append fence. The preflight
also checks requested latest-match provenance and selected durable wake receipt IDs,
including a separate retained wake-history witness. Match history scans
are bounded to 1–500 revisions per requested ID, 64 KiB per row,
1 MiB aggregate serialized bytes and an SQL deadline; a truncated
match history must fail closed rather than certifying missing provenance.
It enforces explicit 1–10,000 source/audit budget and at most 100
match/wake IDs per run. It emits no raw event payload, provider cursor,
OAuth token or source arguments; in every result:
`sourcePruneAuthorized:false`,
`auditPruneAuthorized:false`,
`receiptPruneAuthorized:false`,
`archiveBackedReplayFloorEstablished:false`,
`providerCompletenessCertified:false`,
`externalArchiveCertified:false`.

**Important:** this diagnostic calls several existing verified read-only
store methods; they are **not a single cross-category atomic snapshot**.
New source/audit writes interleaved between reads can fail this preflight
conservatively. A successful report is a local bounded integrity
observation, **not authorization to delete** or assertion of global
tamper resistance against a privileged database administrator. A
different production app cannot bypass these guarantees by directly
executing SQL DELETE and still claim SDK-supported no-prune semantics.

## Actual PostgreSQL16 evidence

`test/postgres-v1-no-prune-retention.test.mjs` exercises:
- two independent PostgreSQL pools, isolated tenants and live source +
  append-only audit + delivered and pending wakes;
- real paginated physical compaction of terminal duplicate history,
  including refusal of `audit`/`mcp_occurrence` kinds, no active-match
  or pending-wake deletion, stable source dedup/checkpoint and audit hash;
- release/renew independent pool and cold state initialization, preserved
  provider event replay, duplicate rejection and wake host receipt;
- manual source history deletion, dedup key deletion, wake history deletion
  despite a still-present receipt, and audit prefix
  deletion, all failing closed, while an unaffected tenant stays valid;
- bounded preflight denial, no secret exposure, and no implicit
  external archive, provider finality or physical prune authorization.

This demonstrates a concrete conservative **SDK v1 safe non-pruning**
policy and its local resilience; it is **not** an off-host immutable
retention implementation or cost/SLO promise. Full immutable archive,
provider-specific replay floor, PostgreSQL failover RPO/RTO and
production long-haul test are optional enterprise/deployment evidence
in [#376](https://github.com/sarooo17/event-intelligence/issues/376).
PostgreSQL storage capacity/retention obligations remain with the host
operator, and a future compacting major version will need a separately
reviewed migration and destructive-operation safety protocol.
