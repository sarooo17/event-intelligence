# Signed MCP source occurrence archive witness (#47)

**Status: additive, non-destructive export authentication. NOT off-host immutable storage, a provider replay-floor protocol or authorization for TTL/pruning.** #47 and transferred #21 retention remain blocked.

Source occurrence archives already bind their original PostgreSQL `JSONB::text` history to a complete, externally authenticated checkpoint. This change adds an operator-controlled **detached Ed25519 signature** binding the **exact source archive file bytes** to the *complete* source checkpoint and a key identifier, parallel to the existing audit archive witness.

## Signing an independently pinned complete source archive

```js
import {
  verifyMcpOccurrenceArchiveBundleFile,
  signMcpOccurrenceArchiveWitness,
  verifyMcpOccurrenceArchiveWitness,
} from 'mcp-event-intelligence/storage/postgres/archive';
import {readFile} from 'node:fs/promises';

// These inputs come from independently protected operator custody, NOT
// from the source database, bundle JSON, or an untrusted GitHub artifact:
const trustedCheckpoint = externalTrustedSourceCheckpoint;
const privateKeyPem = offlineOperatorEd25519PrivateKeyPem;
const trustedPublicKeyPem = externallyPinnedEd25519PublicKeyPem;
const keyId = 'operator-off-host-key-2026-01';

if (!await verifyMcpOccurrenceArchiveBundleFile('/secure/source.json', {
  trustedCheckpoint,
})) throw new Error('Reject untrusted source archive');

const archiveBytes = await readFile('/secure/source.json');
const witness = await signMcpOccurrenceArchiveWitness({
  archiveBytes, trustedCheckpoint, privateKeyPem, keyId,
});

// Later, independently and offline, always re-read the ORIGINAL bytes;
// independently pin the expected tenant, full checkpoint, public key and ID.
const ok = await verifyMcpOccurrenceArchiveWitness({
  witness, archiveBytes, trustedCheckpoint, trustedPublicKeyPem,
  expectedKeyId:keyId, expectedScopeId:trustedCheckpoint.scopeId,
});
if (!ok) throw new Error('Signed source archive witness invalid');
```

The signing operation requires:
- Original bytes, bounded by 64 MiB, not a parsed or reserialized object.
- The **whole independently authenticated** source checkpoint: schema, tenant scope, genesis hash, end sequence and head hash. Any change, including a valid older signed prefix, fails against the current externally pinned checkpoint.
- Strict UTF-8 and unambiguous JSON object member names, including escaped-name aliases. Unsafe or lossy *outer archive* numeric tokens fail before signing. Inner arbitrary-precision PostgreSQL occurrence payloads remain original opaque JSONB strings and are authenticated by the existing hash-chain proof.
- An externally controlled Ed25519 private key; no key is generated, persisted or fetched from PostgreSQL by EI.
- Exactly validated detached witness fields; unsigned extra fields cannot imply destructive-retention approval.

Verification checks the separate operator trust roots, exact file SHA-256 and length, signature, complete source archive hash-chain/pagination proof and tenant scope. Using an in-file public key or the in-file checkpoint as the **only** root of trust is forbidden. Keep witness, key custody and checkpoint anchors in separate trusted storage with explicit rollback protection.

## What this does NOT prove

An Ed25519 signature **does not guarantee an immutable remote copy exists or remains available**. It is not a WORM uploader, a third-party retention attestation, a trusted timestamp, a valid provider opaque-cursor low-watermark, an audit-prefix pruning scheme, or Pattern/CEP/wake state restoration. No source, dedup, match, wake or audit data is deleted. Do **not** enable retention pruning based on a successful verification.

Tests:
- `test/postgres-mcp-archive-witness.test.mjs`: standalone signature/tenant/key/checkpoint/byte-mutation, ambiguous JSON, unsafe keys and rollback rejection.
- `test/postgres-mcp-archive-bundle.test.mjs`: with `POSTGRES_URL`, real PG16 nonempty multi-page source archive signed and verified offline, including later-checkpoint rollback and exact-byte tamper rejection.

**Compatibility:** additive exports under the existing `/storage/postgres/archive` entrypoint and matching declarations. No persisted schema, wire protocol, runtime behavior, automatic signing, background work or consumer API migration; no package publish here.
