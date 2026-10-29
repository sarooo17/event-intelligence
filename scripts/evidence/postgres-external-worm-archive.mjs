import { createHash, randomUUID } from 'node:crypto';
import { verifyMcpOccurrenceArchiveWitness } from '../lib/mcp-occurrence-archive-bundle.mjs';
import { verifyPostgresAuditArchiveWitness } from '../lib/postgres-audit-archive-bundle.mjs';

const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { const error = new Error('EI WORM archive refused: ' + code); error.code = 'EI_WORM_' + code; throw error; };
const bytesSnapshot = value => {
  if (!Buffer.isBuffer(value) || value.length < 2 || value.length > MAX_OBJECT_BYTES) fail('INVALID_ARCHIVE_BYTES');
  return Buffer.from(value);
};
const validUntil = value => value instanceof Date && Number.isFinite(value.getTime()) &&
  value.getTime() >= Date.now() + 7 * 24 * 60 * 60 * 1000;
const safeKey = value => typeof value === 'string' && /^[a-z0-9][a-z0-9/_.-]{0,160}$/.test(value) &&
  !value.includes('..') && !value.includes('//') && !value.endsWith('/');

/**
 * This is an operator-side WORM publisher, not an EI worker integration.
 * It never removes or prunes PostgreSQL rows. It refuses ordinary buckets,
 * governance-only locks, non-versioned stores and missing readback evidence.
 *
 * The injected S3 SDK client/command constructors keep the normal EI package
 * independent of any cloud vendor SDK. No network is touched at import time.
 */
export async function uploadComplianceLockedObject({ client, commands, bucket, key, bytes, retainUntil }) {
  const contents = bytesSnapshot(bytes);
  const lockedUntil = retainUntil instanceof Date ? new Date(retainUntil.getTime()) : null;
  if (!client || typeof client.send !== 'function' || !commands ||
      typeof bucket !== 'string' || !bucket || !safeKey(key) || !validUntil(lockedUntil)) {
    fail('INVALID_UPLOAD_CONFIG');
  }
  for (const name of ['PutObjectCommand','HeadObjectCommand','GetObjectCommand']) {
    if (typeof commands[name] !== 'function') fail('MISSING_S3_COMMAND');
  }
  const hash = checksum(contents);
  const put = await client.send(new commands.PutObjectCommand({
    Bucket: bucket, Key: key, Body: contents,
    ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date(lockedUntil.getTime()),
    Metadata: { 'ei-sha256': hash },
    ContentType: 'application/octet-stream',
  }));
  const versionId = put?.VersionId;
  if (typeof versionId !== 'string' || !versionId || versionId === 'null') fail('NO_IMMUTABLE_VERSION_ID');
  const head = await client.send(new commands.HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  const until = head?.ObjectLockRetainUntilDate;
  const remoteTime = until instanceof Date ? until.getTime() : Date.parse(until);
  if (head?.VersionId !== versionId || head?.ObjectLockMode !== 'COMPLIANCE' ||
      !Number.isFinite(remoteTime) || remoteTime < lockedUntil.getTime() ||
      Number(head?.ContentLength) !== contents.length ||
      head?.Metadata?.['ei-sha256'] !== hash) fail('REMOTE_LOCK_ATTESTATION_FAILED');
  const read = await client.send(new commands.GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  if (typeof read?.Body?.transformToByteArray !== 'function') fail('READBACK_NOT_SUPPORTED');
  const remote = Buffer.from(await read.Body.transformToByteArray());
  if (remote.length !== contents.length || checksum(remote) !== hash || !remote.equals(contents)) {
    fail('REMOTE_BYTES_MISMATCH');
  }
  return Object.freeze({key,versionId,sha256:hash,bytes:contents.length,
    objectLockMode:'COMPLIANCE',retainUntil:lockedUntil.toISOString(),readBackVerified:true});
}

async function requireObjectLockBucket(client, commands, bucket) {
  if (typeof client?.send !== 'function' || typeof commands?.GetBucketVersioningCommand !== 'function' ||
      typeof commands?.GetObjectLockConfigurationCommand !== 'function' ||
      typeof bucket !== 'string' || !bucket) fail('INVALID_BUCKET_CONFIG');
  const versioning = await client.send(new commands.GetBucketVersioningCommand({Bucket:bucket}));
  if (versioning?.Status !== 'Enabled') fail('BUCKET_VERSIONING_DISABLED');
  const configuration = await client.send(new commands.GetObjectLockConfigurationCommand({Bucket:bucket}));
  if (configuration?.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled') fail('BUCKET_OBJECT_LOCK_DISABLED');
}

/**
 * Requires independently pinned Ed25519 public key, key IDs and checkpoints,
 * not values fetched from either archive, witness or the PostgreSQL store.
 * All four verified pieces and a receipt manifest are uploaded to an external
 * S3-compatible COMPLIANCE WORM bucket, never a Railway bucket.
 *
 * Success proves exact remote bytes, lock/retention and version response at
 * verification time. It does not prove external provider replay floors,
 * audit-prefix continuation, clock trust, multi-region durability or prune
 * authorization. Even a successful result MUST NOT enable deletion.
 */
export async function publishSignedSourceAndAuditWorm({
  client, commands, bucket, retainUntil,
  sourceArchiveBytes, sourceWitness, sourceCheckpoint,
  auditArchiveBytes, auditWitness, auditCheckpoint,
  trustedPublicKeyPem, sourceKeyId, auditKeyId, expectedScopeId,
} = {}) {
  if (!validUntil(retainUntil) || typeof expectedScopeId !== 'string' || !expectedScopeId ||
      sourceCheckpoint?.scopeId !== expectedScopeId ||
      auditCheckpoint?.scopeId !== expectedScopeId ||
      typeof trustedPublicKeyPem !== 'string' || !trustedPublicKeyPem.trim()) fail('TRUST_ROOT_REQUIRED');

  // Snapshot all mutable operator inputs BEFORE the first asynchronous check.
  // The same exact bytes/checkpoints are used for signing verification, S3
  // publication and the manifest. Caller mutation cannot swap signed content.
  const lockedUntil = new Date(retainUntil.getTime());
  const source = bytesSnapshot(sourceArchiveBytes);
  const audit = bytesSnapshot(auditArchiveBytes);
  const pinnedSource = structuredClone(sourceCheckpoint);
  const pinnedAudit = structuredClone(auditCheckpoint);
  const signedSource = structuredClone(sourceWitness);
  const signedAudit = structuredClone(auditWitness);
  const sourceWitnessBytes = Buffer.from(JSON.stringify(signedSource));
  const auditWitnessBytes = Buffer.from(JSON.stringify(signedAudit));
  const sourceOk = await verifyMcpOccurrenceArchiveWitness({
    witness:signedSource,archiveBytes:source,trustedCheckpoint:pinnedSource,
    trustedPublicKeyPem,expectedKeyId:sourceKeyId,expectedScopeId,
  });
  const auditOk = await verifyPostgresAuditArchiveWitness({
    witness:signedAudit,archiveBytes:audit,trustedPublicKeyPem,
    expectedKeyId:auditKeyId,expectedScopeId,
  });
  if (!sourceOk || !auditOk || signedAudit?.checkpoint?.scopeId !== pinnedAudit.scopeId ||
      signedAudit?.checkpoint?.firstHash !== pinnedAudit.firstHash ||
      signedAudit?.checkpoint?.endSequence !== pinnedAudit.endSequence ||
      signedAudit?.checkpoint?.headHash !== pinnedAudit.headHash) {
    fail('PINNED_WITNESS_INVALID');
  }
  await requireObjectLockBucket(client,commands,bucket);

  // Fresh unguessable namespace and fixed roles: never overwrite any logical
  // object in a different version (and never use mutable "latest" references).
  const namespace = 'ei-archive/' + checksum(Buffer.from(expectedScopeId)).slice(0,24) + '/' + randomUUID();
  const items = [
    ['source-archive.json',source],
    ['source-witness.json',sourceWitnessBytes],
    ['audit-archive.json',audit],
    ['audit-witness.json',auditWitnessBytes],
  ];
  const receipts = [];
  for (const [name,body] of items) {
    receipts.push(await uploadComplianceLockedObject({
      client,commands,bucket,key:namespace+'/'+name,bytes:body,retainUntil:lockedUntil,
    }));
  }
  const manifest = Buffer.from(JSON.stringify({
    schema:'event-intelligence.external-worm-archive-receipt.v1',
    scopeSha256:checksum(Buffer.from(expectedScopeId)),
    sourceCheckpointSha256:checksum(Buffer.from(JSON.stringify(pinnedSource))),
    auditCheckpointSha256:checksum(Buffer.from(JSON.stringify(pinnedAudit))),
    objects:receipts,
    productionRetentionCertified:false,physicalPruneAuthorized:false,
  })+'\n');
  const receipt = await uploadComplianceLockedObject({
    client,commands,bucket,key:namespace+'/manifest.json',bytes:manifest,retainUntil:lockedUntil,
  });
  return Object.freeze({
    schema:'event-intelligence.external-worm-archive-receipt.v1',
    bucket,namespace,objects:Object.freeze(receipts),manifest:receipt,
    externalReadbackVerified:true,physicalPruneAuthorized:false,
    productionRetentionCertified:false,
    stillRequired:['independent operator custody and external availability proof',
      'provider opaque cursor replay floor','atomic source/audit prefix continuation',
      'CEP/match/wake/host receipt state restore and safe physical pruning'],
  });
}
