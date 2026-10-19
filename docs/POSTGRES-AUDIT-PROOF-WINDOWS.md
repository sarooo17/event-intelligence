# PostgreSQL audit archive proofs — externally pinned snapshot required

**Status:** non-destructive prerequisite for #47 audit retention. No audit
entries, MCP occurrences, match evidence, receipts or dedup keys are deleted.

The current `AuditChain` verifies from genesis (sequence 0,
`previousHash:null`). Physically deleting an audit prefix today would
break the append path and `verifyAudit()`. This change provides bounded
*exports* and independent verification, **not** a pruning policy.

## Contract

1. `store.getAuditCheckpoint()` validates the **complete** PostgreSQL
   tenant audit chain and returns `{scopeId, firstHash, endSequence,
   headHash}`. This operation is O(total audit history) and is
   **operator-controlled**, not used in ingestion. It can be expensive.
2. The operator must independently authenticate and pin that tuple outside
   the same database (e.g. trusted signed WORM archive manifest). A hash
   freshly supplied with an untrusted proof is **not** independently trusted.
   The initial checkpoint itself is only as trustworthy as the source and
   chain verification at the moment of pinning; it cannot prove a
   compromised historical genesis was once authentic.
3. `store.getAuditProofWindow({checkpoint,afterSequence:-1,limit:100})`
   provides at most 1000 contiguous audit records from the **pinned
   snapshot**, including the predecessor hash, ending sequence/head hash
   and `hasMore`. It uses the same scope-local PostgreSQL advisory
   lock as audit appends, and paginates by physical `history_id` so a
   damaged/missing JSON sequence cannot silently vanish from a page.
   New audits appended *after* the checkpoint do not extend this snapshot.
4. `verifyAuditProofWindow(proof, {trustedCheckpoint,
   trustedAfterSequence,trustedPreviousHash,trustedLimit})` checks the
   externally pinned scope, first (genesis) hash, terminal sequence and
   hash, the requested fixed page size, each canonical SHA256 record hash
   and predecessor link. It rejects changed scope, truncated suffix,
   reordered/missing entries, invalid chain, or a claimed false end.
   Each next page uses the *previous independently validated* head and
   end sequence. The final window must land at the checkpoint's terminal
   sequence/hash. The overall export is authentic only when the full
   chain of windows has reached the trusted terminal commitment.

## Operational limits

- **No implicit trust in a database-reported checkpoint.** Its scope,
  genesis hash and terminal hash must already be pinned by an independent
  trusted system. Creating the checkpoint and immediately accepting it
  from the same potentially compromised database is not independent
  provenance.
- No external archive/WORM writer, archive signatures, lifecycle TTL,
  source-replay fence, interruption-resumable archive transaction, or
  checkpoint-aware pruning has been added.
- Exports are read-only; the original PostgreSQL audit history, chain
  verification and write behavior remain unchanged.
- The proof verifier validates a bounded window against an externally
  trusted whole-snapshot commitment. It does not sign data itself or
  certify live producer completeness beyond the snapshot boundary.

**PG16 regression:** `test/postgres-audit-proof-windows.test.mjs`
covers separate pools and concurrent audit append, chained snapshots,
tenant isolation, tampered/reordered/skipped evidence, forged genesis
scope relabeling, suffix-shortening attempts, and direct on-disk
corruption fail-closed behavior. No schema migration, regex refactor,
Muffin/Artemis adapter update or npm publication is included.

The #47 append-only retention/compaction acceptance **remains open**
until external archive commitment, safe checkpoint-aware deletion and
crash/replay/audit conformance tests are designed and actually validated.
