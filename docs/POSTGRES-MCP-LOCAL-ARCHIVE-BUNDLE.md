# Operator-controlled MCP occurrence archive bundle (#47)

This additive helper **exports a complete locally written artifact** based
on a separately pinned MCP occurrence checkpoint. It builds on
`docs/POSTGRES-MCP-OCCURRENCE-ARCHIVE-PROOFS.md`. It is **NOT** a WORM
writer, signature, remote archive, retention policy or approval to delete
original source history, dedup keys, host receipts or audit.

## Use in an operator-controlled environment

First obtain `store.getMcpOccurrenceArchiveCheckpoint()`, independently
authenticate/pin its entire JSON tuple **outside PostgreSQL and outside the
bundle file**. Treat the source database and bundle bytes as untrusted relative
to that external anchor. Operator code can then:

```js
import {
  writeMcpOccurrenceArchiveBundle,
  verifyMcpOccurrenceArchiveBundleFile,
} from 'mcp-event-intelligence/storage/postgres/archive';

await writeMcpOccurrenceArchiveBundle(store, {
  trustedCheckpoint, // externally pinned trusted manifest
  outputPath: '/secure/offline-export/source-bundle.json',
  pageSize: 250,
});
const verified = await verifyMcpOccurrenceArchiveBundleFile(
  '/secure/offline-export/source-bundle.json',
  { trustedCheckpoint },
);
if (!verified) throw new Error('Archive must not be accepted');
```

- Uses read-only `getMcpOccurrenceArchiveWindow` calls and verifies each
  lossless JSONB-text page against an independently supplied predecessor
  hash and frozen checkpoint.
- Assembles all pages through the trusted terminal sequence and hash,
  rejecting missing/reordered/tampered/incomplete data before publication.
- Rejects existing target paths *before* any database export; writes an
  unpredictable temporary file in the same directory with mode `0600`,
  flushes it, publishes via an exclusive hard link, then **fsyncs the\n  destination directory** before reporting success. The destination
  is either fully formed or absent, never partly overwritten. No upload,
  cloud storage or network transfer is performed by the helper.
- Enforces 1–1000 records/page and 1024 bytes–64 MiB total artifact size\n  incrementally while writing one page at a time;
  out-of-budget exports fail without creating a success-shaped target.
- Pure offline verification opens one regular file with `O_NOFOLLOW`,\n  enforces its byte limit with bounded reads on that same file descriptor,\n  and uses the externally pinned checkpoint provided
  by the operator; the checkpoint embedded in an arbitrary bundle does
  **not** become trusted simply by being present in the bundle.

## Remaining blockers for actual retention

The output file is on local operator-managed POSIX storage and the filesystem
hard link is **not** an immutable WORM archive or verified restorable
backup. A malicious administrator with file/database access can edit both
unless the checkpoint and archive are protected independently. Signatures,
off-host lifecycle policy, deletion authorization, source/subscription replay
cursor floors, unresolved MCP delivery-gap protection, active CEP state,
pending wake/dedup lifetime, externally pinned audit-prefix continuation and
post-prune recovery are intentionally not implemented. **Do not prune.**

`test/mcp-occurrence-archive-bundle.test.mjs` covers complete source
export, exact pinned verification, truncated/tampered payloads, stale-output
refusal, write failure and byte limits, permissions and empty scope.

`test/postgres-mcp-archive-bundle.test.mjs` additionally uses two independent
real PostgreSQL 16 pools to export a complete source prefix, ingest later
events, verify that source-ID dedup still works, mutate the database's old
source history and re-verify the *standalone* file against its original
externally supplied checkpoint. The test validates physical export flow,
not off-host signing, WORM durability or an authorized physical purge.
