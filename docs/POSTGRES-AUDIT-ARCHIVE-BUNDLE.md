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

## Optional independently signed archival witness

An off-database auditor may use the exported Ed25519 functions to issue
a detached cryptographic witness over the **exact file bytes** and the
original complete scope/genesis/terminal checkpoint. The signing private
key must be held by the operator or separate signing service; **never**
in the EI/ERP application workers or PostgreSQL storage. The trusted
public key and its expected identifier/scope must be pinned out of band,
not read from the archive itself:

```js
import {readFile} from 'node:fs/promises';
import {
  signPostgresAuditArchiveWitness,
  verifyPostgresAuditArchiveWitness,
} from 'mcp-event-intelligence/storage/postgres/audit-archive';

const archiveBytes=await readFile('/secure/exports/audit-chain.json');
const witness=await signPostgresAuditArchiveWitness({
  archiveBytes,trustedCheckpoint,privateKeyPem:offlineSigningKey,
  keyId:'operator-offhost-2026-01',
});
const accepted=await verifyPostgresAuditArchiveWitness({
  witness,archiveBytes,trustedPublicKeyPem:trustedOperatorPublicKey,
  expectedKeyId:'operator-offhost-2026-01',expectedScopeId:'my-tenant',
});
if(!accepted)throw new Error('Reject unsigned/tampered archive');
```

The signer recomputes the **entire** bounded audit proof from the supplied
raw bytes before signing. The verifier checks the Ed25519 signature
against its independent external key, exact archive byte length/hash,
expected key ID and scope, and the original complete audit chain. These
checks detect content replacement, a wrong tenant, forged receipt, wrong
checkpoint, wrong public key and missing/altered audit pages. The witness
never embeds the public key or generates a signing key on behalf of an
operator.

**This is signing, not remote durability or immutable storage.** A
privileged operator can still erase both the local archive and its
signature. The private key must be protected and its trusted ownership
established externally; the signature proves who signed the committed
bytes, not when or whether every provider event was originally ingested.
Off-host versioned WORM upload, independently retained checkpoints,
provider replay floors, audit-prefix continuation and tested restore
still block authorizing any physical deletion. No auto-signing, auto-upload,
auto-retention or pruner is enabled by this API.

## JSONB numeric precision: fail-closed audit proofs

**An important PostgreSQL-to-JavaScript integrity boundary:** JSONB can
represent numeric lexemes that `JSON.parse` rounds to a different IEEE-754
`Number` (for example, `9007199254740992` vs `9007199254740993`, or
`2` vs `2.0000000000000001`). Re-hashing only the parsed JavaScript
value would allow an altered source number to evade audit hash checks.

Audit checkpoint and proof-window reads therefore inspect PostgreSQL's
original `payload::text` **before** converting to JavaScript objects.
The standalone archive verifier and signed-witness APIs also require the
original **raw archive file bytes**, scan the numeric lexemes outside JSON
strings and reject unsafe precision with
`EVENT_INTELLIGENCE_AUDIT_PRECISION_UNSAFE` at the store boundary (or
`false` in a verifier). The object-based verification API intentionally
requires an associated `rawArchiveBytes` Buffer: a pre-parsed object
cannot authenticate numeric spellings that JavaScript already rounded.

This policy is conservative: an audit record legitimately containing a
high-precision numeric JSON value may **not** be exportable. Represent
large identifiers, high-precision currency decimals or arbitrary-precision
values as **strings** in audit details. Rejection is a deliberate safety
failure, not permission to skip records or rewrite the established audit
hash chain. A future precision-preserving canonical hash version may
support richer exact numeric types; it would require an explicit reviewed
compatibility contract and full migration tests.

## Signed payload completeness and async buffer-safety

The audit record schema historically uses non-strict object parsing:
unexpected top-level fields can otherwise be discarded before checking
its SHA-256 commitment. Archive proof verification and PostgreSQL
checkpoint/page reads now explicitly require that the original record
matches the **entire parsed record object**, preventing unsigned extra
top-level bytes from becoming part of a signed export. Nested audit
`details` values remain covered by the canonical audit hash and are not
silently discarded.

`signPostgresAuditArchiveWitness` copies the caller-owned raw Buffer
**before the first asynchronous proof check**. Every subsequent parse,
page verification, SHA-256 and Ed25519 signature uses that same private
immutable byte snapshot; a caller changing its original Buffer during an
await cannot cause the signature to bind unverified content. The raw
object verifier similarly copies and parses the provided bytes and uses
the frozen parsed representation rather than a mutable caller-supplied
object. The witness verifier checks the signature against a consistent
buffer snapshot, never a different post-await view.

The PG16 test injects unsigned top-level fields directly into PostgreSQL
and serialized archive bytes, and mutates a caller-owned buffer while
the signer is awaiting audit hash verification. Both attacks must be
rejected or correctly bound to the original verified snapshot.
