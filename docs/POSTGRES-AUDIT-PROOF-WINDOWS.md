# PostgreSQL audit proof windows (non-destructive archive prerequisite)

Issue #47 requires traceable, tamper-evident audit retention before any
historical audit rows can be deleted. The current `AuditChain` starts at
sequence zero with a genesis `previousHash: null` and verifies **all**
records from the beginning; deleting a prefix today would break
`verifyAudit()`, ordinary append, and chain continuity.

This first, independently testable slice **does not delete any audit rows**.
It adds two advanced storage operations:

- `store.getAuditProofWindow({ afterSequence: -1, limit: 100 })`:
  serializes against audit writers across PostgreSQL pools, reads an
  ordered, scope-local window of at most 1–1000 entries, paged by immutable PostgreSQL history IDs rather than untrusted JSON sequence fields, with its
  predecessor hash, `headHash`, `endSequence`, and `hasMore`.
  It validates sequence continuity, every canonical SHA-256 record hash,
  and predecessor links *before* returning.
- `verifyAuditProofWindow(proof, { trustedAfterSequence,
  trustedPreviousHash, trustedScopeId })`: independently verifies a
  received proof against a **separately pinned** anchor and tenant identity;
  refuses untrusted or missing anchors, reordered, truncated, or altered
  records. It can run without a PostgreSQL connection.

## Operator handoff

1. Start at `afterSequence: -1` and `trustedPreviousHash: null`
   with the expected tenant scope. Verify every exported chunk off-host.
2. Save an immutable/externally pinned copy of the scope, end sequence
   and head hash *together with the complete archive window*; a hash
   stored only in the same writable database is **not** an external
   integrity guarantee. The host decides storage/WORM, encryption,
   access controls, time-based retention and backup policies.
3. For the next window pass the previous verified `endSequence` and
   `headHash` as *trusted* inputs; verify continuity. Never derive
   trusted inputs from the unverified window you are checking.
4. Re-check audit count, `listAudit`, and `verifyAudit()`.
   Window exports never modify the operational chain.

All audit records remain in EI PostgreSQL. No automatic archiver,
checkpoint table, background pruning, producer cursor changes,
JSONL retention, or schema migration is included.

## Proven vs unproven

The real-PG16 `postgres-audit-proof-windows.test.mjs` checks empty
genesis, concurrent writers, separate pool reads, multi-chunk anchor
continuity, cross-tenant isolation, skipped/reordered/tampered proof
rejection, validation of a directly damaged on-disk JSONB payload,
and unchanged persistent audit count and verification before tampering.

This **does not** establish trustworthy off-site WORM storage,
external anchoring/countersignatures, long-term archive retrieval,
proof of non-equivocation when a database is already compromised at
the *initial* genesis export, or a valid design for physically
deleting audit prefixes. Full #47 compaction/TTL acceptance stays
unchecked. Future deletion needs checkpoint-aware append/verify APIs,
cross-worker cutover fencing and recovery tests across retained vs
archived history (including trace/receipt provenance).

Compatibility: additive advanced PostgreSQL export and pure proof
verifier, no destructive retention, public MCP command changes,
regex modifications, package release, Muffin or Artemis upgrade.
