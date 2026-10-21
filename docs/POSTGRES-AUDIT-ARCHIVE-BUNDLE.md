# Complete PostgreSQL audit chain archive — operator mode, #47

**Status: non-destructive verifiable local export. NOT approved audit-prefix
deletion, off-host WORM storage, provider replay pruning or v1 readiness.**

The existing `getAuditCheckpoint()` and `getAuditProofWindow()` methods
provide a frozen scope-specific checkpoint plus verified, chained pages.
The new `mcp-event-intelligence/storage/postgres/audit-archive` package
exports an operator-only **whole-prefix** bundle writer and independent
offline verifier:

```js
import {
  writePostgresAuditArchiveBundle,
  verifyPostgresAuditArchiveBundleFile,
} from 'mcp-event-intelligence/storage/postgres/audit-archive';

// This tuple MUST be authenticated and pinned independently of the
// database and the archive file BEFORE being used as a trust root.
await writePostgresAuditArchiveBundle(store,{
  trustedCheckpoint,outputPath:'/secure/exports/audit-chain.json',
  pageSize:250,
});
if(!await verifyPostgresAuditArchiveBundleFile(
  '/secure/exports/audit-chain.json',{trustedCheckpoint},
))throw new Error('Reject audit archive');
```

The export uses validated SHA-256 audit proof windows, enforces correct
consecutive sequences and preceding hashes, authenticates the frozen
terminal hash and scope, and refuses a truncated or additional page.
A zero-record chain is a valid zero-page export. All validation uses
the **independently authenticated checkpoint** supplied by the operator;
the checkpoint bundled in the artifact is *not* itself a trust root.

The local file writer is page-streaming, capped at 64 MiB and a maximum
of 10,000 audit records; it uses a private mode-0600 temporary file,
`fsync` on file contents, an exclusive non-overwriting hard link,
staging unlink, then a directory `fsync` before reporting completion.
Failing reads, validation, byte limits, partial I/O or an existing output
path must not be reported as success. The offline verifier opens a single
regular file with `O_NOFOLLOW` and applies bounded byte reads rather than
trusting an earlier stat on a replaceable path.

**Safety boundary:** no audit source data is removed or rewritten, no
automatic job is enabled, and the hash genesis remains unchanged. This
archive is **local** and can be edited/deleted by a privileged operator.
It is not a signature, trusted time attestation, third-party retained
copy or immutable off-host backup. The audit append path still depends
on the complete genesis-linked chain: removing its prefix today breaks
`appendAudit` and `verifyAudit`. Until a separately signed/immutable
anchor and checkpoint-aware chain continuation/recovery are implemented
and proven under crash/replay, **DO NOT PRUNE AUDIT HISTORY**.

The real PG16 regression
`test/postgres-audit-archive-bundle.test.mjs` exercises separate pools,
cross-tenant isolation, empty/complete chain, offline tamper/truncation
detection, source database corruption *after* exporting a valid archive
and appends after the pinned checkpoint. It asserts the full historical
database chain and other tenant records are untouched.
