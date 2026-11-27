# Portable host recovery boundary (experimental)

**Scope:** legacy persisted EI `0.11.0` JSONL to v1, **offline synthetic / isolated recovery rehearsal only**.
This is a **host-neutral SDK interface**, not an official MCP standard, lossless migration,
a runtime-specific adapter or a permission to resume old watches.

The published v1 SDK already exposes runtime-neutral embedded-host and
conformance APIs. This *draft* implements a separate, opt-in **repository-local**
`scripts/legacy-recovery-host.mjs` boundary with matching TypeScript declarations.
A future versioned release may expose `mcp-event-intelligence/host/recovery`
only after an explicit npm compatibility and release review. It does not change the
normal `mcp-event-intelligence/embedded` core, require Muffin, or contain a
special-case branch for any particular agent runtime.

## Stable design boundary

| EI recovery layer validates | Hosting runtime implements |
| --- | --- |
| Old archived receipt and event identity, source fingerprint, strict replay filtering | Durable host effect ledger; independently stable receipt IDs |
| Source cursor continuity checks and event payload collision/gap refusal | Actual MCP transport/client, provider-side replay attestation and source guarantees |
| Durable poll/write-ahead intent and checkpoint requirement | Strong exclusive worker fencing/lease and lifecycle authorization |
| Generic receipt/checkpoint proof shape and scoped tenant binding | Readback of **its own** persistent job/turn/checkpoint progress, with exact tenant/authority |
| Strict refusal on missing evidence | Backup/rollback, owner consent, and continuation dispatch |

EI neither knows nor opens any specific runtime database. A job scheduler might
store receipts in a JSONL queue; a graph orchestrator might use a workflow
checkpoint database; an agent host might use a SQLite TurnStore. Each exposes
the same **portable capabilities** through callbacks.

## Contract: four host-owned capabilities

Import the **repository-local module for development/testing only**.
This is **not** an available published npm subpath in v1.0.0:

```js
import {
  createLegacyRecoveryHostBridge,
  openLegacyHostGapJournal,
  prepareLegacyHostRecovery,
} from '../scripts/legacy-recovery-host.mjs';

const host = createLegacyRecoveryHostBridge({
  runtimeId: 'my-agent-runtime',
  tenantId: 'my-tenant',
  authority: {
    // MUST be backed by a real host lease/fencing mechanism.
    assertExclusive: async (binding) => hostRuntime.assertRecoveryLease(binding),
  },
  receipts: {
    // MUST read independent, durable, host-issued receipt storage.
    lookup: async (request) => hostRuntime.readDurableWakeReceipt(request),
  },
  source: {
    // MUST have provider evidence, not fabricated stable-ID booleans.
    attestContinuity: async (evidence) => provider.verifyReplayFrontier(evidence),
  },
  checkpoints: {
    // MUST read an actually persisted new EI source cursor.
    readDurable: async (request) => hostRuntime.readPersistedMcpCheckpoint(request),
  },
});

// An operator must stop/fence ALL old writers, back up and isolate the
// original Home, and explicitly bind a verified source snapshot. Create
// the host-owned journal ONCE, outside the old v0.11 EI source directory.
const binding = {
  expectedSourceSnapshotSha256: '<64-lowercase-hex-SHA256>',
  sourceIdentitySha256: '<64-lowercase-hex-source-ID-digest>',
};
const epoch = await host.assertExclusive(binding);
const journal = await openLegacyHostGapJournal({
  directory: '<isolated-host-owned-directory>',
  mode: 'create',
  sourceSnapshotSha256: binding.expectedSourceSnapshotSha256,
  sourceIdentitySha256: binding.sourceIdentitySha256,
  tenantId: 'my-tenant',
  authorityEpoch: epoch,
});
const rehearsal = await prepareLegacyHostRecovery({
  host, journal, sourceDir: '<quiesced-legacy-store>',
  ...binding,
});
// rehearsal.safeToResumeOrDeploy === false: do NOT attach a live candidate.
```

The import path above is illustrative of local repository testing; adapt it
relative to your test location. A package-level export would require a
new release with an updated public npm export manifest. The placeholders
above are **not** ready-to-use runtime methods. A host adapter
must map them to its actual authorization and persistence APIs, verify
receipt principal `system:automation`, and return the exact typed shapes in
`scripts/legacy-recovery-host.d.mts`. EI does not make those methods up.

A generic `rehearsal.wrapConnection(connection)` rejects stale host epochs
before and after provider poll requests. Every old archived receipt must
match an actual independently readable host effect; every source frontier
declaration must be bound to the correct source digest, opaque cursor,
subscription identity and tenant. A cold restart must reopen the SAME
host-owned journal with `mode: 'open'`, not manufacture a new ready record.

After a synthetic poll the journal requires checkpoint confirmation. The
host must read its **committed** source progress, then use
`rehearsal.acknowledgePersistedCheckpoint({connectionId,eventName,cursor})`.
A process crash before acknowledgment preserves a blocked recovery state;
the checkpoint proof cannot be generated from EI's memory-only response.

## Host compatibility tests

`test/v011-portable-host-recovery.test.mjs` runs the same contract and
replay isolation scenario against two unrelated **synthetic** host shapes:

- `queue-runner` — job IDs with file-backed queue receipt entries
- `workflow-orchestrator` — keyed workflow checkpoint records

Both read host-owned receipts independently, check a durable host source
checkpoint, and verify old/new event filtering. Both test a stolen
authority epoch: the old connection cannot poll, and a new process
cannot reuse the original journal under a different epoch.

The existing compiled-Muffin 0.11→v1 test remains **one additional consumer
fixture**, not the implementation template. **No runtime-specific naming,
database schema, continuation model, or callback is imported into EI core.**

## Local process contention and host authority

The recovery journal serializes each read/validate/replace transition across
independent processes on a local filesystem with atomic exclusive file
creation. If a process dies while holding the transition lock, a cold open
and further transitions refuse. There is no automatic timeout, takeover or
lock removal. An unexpected storage error may also leave this lock in place;
keep the original archive and require explicit operator disposition. Only
one authorized recovery writer is supported: this is not a distributed lock,
nor permission for an unrelated worker to adopt a running poll.

The existing host authority callback is independently exercised against
two actual PostgreSQL sessions in CI using a host-owned advisory lock.
The non-owner must be denied, and revoking ownership during an in-flight
poll must prevent the response from being returned to EI; a new epoch
cannot adopt the old journal. The PostgreSQL implementation exists in
the test only; hosts choose their own authority store and fencing policy.
The real-process tests also race two Node workers on the same local
journal and kill a worker holding its checkpoint transition lock.

## Important limitations

- This does **not** expand legacy recovery beyond single default-scope,
  single polling MCP source with explicit old archive, **nor** imply that
  EI v1 itself lacks multi-tenant, multi-source or PostgreSQL capabilities.
- The local journal uses file+directory `fsync` and exclusive transitions,
  but remains a **single-authorized-writer** recovery profile. Do not use
  it as distributed locking on arbitrary shared/network filesystems.
  A distributed deployment must enforce end-to-end authority/fencing,
  host-persisted revocation and crash-safe compensation independently,
  including at the actual effect and checkpoint commit boundaries.
- This does not bridge old Pattern candidate state or guarantee a fully
  lossless old Home migration. It is an explicit, narrow recovery option.
- Provider declaration callbacks are trust boundaries, not independent
  proof that any real MCP server retains a complete replay history.
- The reported state is always `safeToResumeOrDeploy:false`. Production
  cutover authorization, user consent, complete host receipt/continuation
  reconciliation, rollback and real provider certification are still open
  in [EI #426](https://github.com/sarooo17/event-intelligence/issues/426).

**Do not merge #962 or publish a new EI version solely because a host
conformance test succeeds.**
