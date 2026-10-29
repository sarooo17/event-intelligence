# External immutable source + audit archive uploader (#47)

**Status: operator-only COMPLIANCE WORM upload and readback implementation; no production off-host retention evidence has been collected yet.** Nothing here authorizes physical source, match, audit, wake or receipt deletion.

Railway Storage Buckets currently do **not** implement object locks or versioning (see https://docs.railway.com/storage-buckets). A Railway volume or bucket is therefore unsuitable for satisfying the #47 external immutable archive requirement. A separate S3-compatible provider with *real* Object Lock and versioning (for example, an explicitly configured AWS S3 Object Lock bucket in **COMPLIANCE** mode) is required.

## Operation

The operator-only publishSignedSourceAndAuditWorm function lives in scripts/evidence/postgres-external-worm-archive.mjs. It is not an MCP tool, worker capability, default export or background job. The operator supplies **independently authenticated** full checkpoints, the source and audit archive bytes, independently created Ed25519 signed witnesses, pinned Ed25519 public key and key IDs, an external WORM bucket, and a future retention deadline (at least seven days).

The uploader accepts a standard AWS SDK v3 S3 client and command constructors **as injected dependencies**. Install the S3 SDK separately in the operator environment; EI does not add it to its runtime or published package.

~~~js
import * as sdk from '@aws-sdk/client-s3';
import { publishSignedSourceAndAuditWorm } from
  './scripts/evidence/postgres-external-worm-archive.mjs';

const receipt = await publishSignedSourceAndAuditWorm({
  client: new sdk.S3Client({region: operatorChosenRegion}),
  commands: sdk,
  bucket: operatorControlledExternalBucket,
  retainUntil: new Date(operatorApprovedRetentionDeadline),
  sourceArchiveBytes: originalSourceBundleBytes,
  sourceWitness: signedSourceWitness,
  sourceCheckpoint: separatelyPinnedSourceCheckpoint,
  auditArchiveBytes: originalAuditBundleBytes,
  auditWitness: signedAuditWitness,
  auditCheckpoint: separatelyPinnedAuditCheckpoint,
  trustedPublicKeyPem: independentlyPinnedPublicKey,
  sourceKeyId: pinnedSourceKeyId,
  auditKeyId: pinnedAuditKeyId,
  expectedScopeId: independentlyPinnedScope,
});
if (receipt.physicalPruneAuthorized !== false) throw Error('Unsafe result');
~~~

No example credentials, secrets, public archive URLs, or actual external bucket is committed. Keep signing keys and checkpoint trust roots away from the EI worker / PostgreSQL credential boundary. Use a *new* archive namespace for each snapshot and retain the version-specific receipt in separately controlled custody. The provider account and bucket deletion permissions must be independently audited.

## Fail-closed rules

1. Independently verify the signed **source and audit archive bytes** against pinned checkpoints, key ID, Ed25519 public key and exact tenant scope before any upload.
2. Check the remote bucket reports versioning **Enabled** and Object Lock **Enabled**. Ordinary Railway/S3 buckets and disabled configurations fail.
3. Upload original bytes, both detached signatures and a receipt manifest as five separate objects using S3 ObjectLockMode COMPLIANCE and the specified retention deadline. Never replace a previous logical object.
4. Require a real, non-null S3 VersionId for every object. HEAD the *specific version* and verify COMPLIANCE, retention deadline, byte length and committed SHA-256 metadata. GET that version and hash the **actual remote bytes** before acknowledging receipt. No unverified, partial, governance-only or HEAD-only upload is called success.
5. Record the exact version-specific receipt and source/audit checkpoint digest outside the host/database. Partial failures leave already locked objects in place: do not delete, shorten retention or silently resume with a different proof root.

These checks verify observations made *at upload/readback time*, not a continuous future availability guarantee. Independently rehearse a later GET-by-version + checksum and provider-level retention enforcement audit. The API intentionally does **not** call S3 DeleteObject, PutObjectRetention or any PostgreSQL DELETE operation.

## Remaining blocking work

- An **actual external provider bucket and credentials** plus authenticated nonempty source and audit snapshots, real upload/independent restore and retention expiry enforcement evidence. Unit mock runs are not evidence.
- A provider-verified opaque cursor -> EI event-sequence replay low-watermark with unresolved-gap fencing, bound into the atomic source/CEP/wake/dedup lifecycle. A signed historical source archive alone cannot prove safe cursor advancement.
- Checkpoint-aware PostgreSQL audit-prefix continuation, external authoritative anchors and replay/restart after physical pruning; audited atomic prune transaction under concurrent multiworker ingest.
- Production PostgreSQL failover/RPO/RTO and independent real MCP provider/host end-to-end SLO measurement.

Neither a successful *mock* upload nor a future real bucket receipt automatically checks #47's full retention checkbox. The publisher always returns physicalPruneAuthorized:false and productionRetentionCertified:false.
