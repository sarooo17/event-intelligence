# EI 0.11 → v1: staged, paused-only JSONL recovery candidate

**Status: DRAFT / QUARANTINE ONLY.** This source-branch helper does NOT
perform a lossless migration or authorize resumption of historical watches.
The source remains intact, with the old host receipt ledger still authoritative.

Built on the [read-only preflight](UPGRADE-V011-JSONL-PREFLIGHT.md) and
tracked by [EI #426](https://github.com/sarooo17/event-intelligence/issues/426)
and [stacked PR #428](https://github.com/sarooo17/event-intelligence/pull/428).

## What it actually does

`stageLegacyWatchesPaused()` creates a **new** v1 JSONL store at an
operator-chosen **nonexistent** directory, using only old active/paused
**watch definitions** that validate against the current v1 schema. For
each one, an explicit host authorization callback supplies a newly
accepted owner and actor. Every staged watch is `paused` with an empty
`connectionIds` list. It writes a quarantine manifest that states
`safeToResumeOrDeploy: false` and counts historical delivered receipts,
but DOES NOT import or convert any of them.

It requires a preflight snapshot digest, checks again after the potentially
asynchronous host authorization callbacks and after writing to detect
ordinary concurrent source changes. The complete existing source is
read-only and remains the rollback candidate.

### Narrow non-production example

```js
import { inspectLegacyJsonlStore } from './scripts/lib/v011-jsonl-upgrade-preflight.mjs';
import { stageLegacyWatchesPaused } from './scripts/lib/v011-jsonl-paused-recovery.mjs';

// Only on a private, isolated, quiesced FULL SOURCE CLONE.
// A real host MUST provide its own approval/policy callback.
const sourceDir = '/isolated/old-copy/event-intelligence';
const preflight = await inspectLegacyJsonlStore(sourceDir, {
  declaredVersion: '0.11.0',
});

const quarantine = await stageLegacyWatchesPaused({
  sourceDir,
  targetDir: '/isolated/new-v1-quarantine-not-for-traffic',
  declaredVersion: '0.11.0',
  expectedSourceSnapshotSha256: preflight.sourceSnapshotSha256,
  authorizeWatch: async ({ scopeId, legacyOwner, definition }) => {
    // Example deliberately REFUSES every unverified owner. The host must
    // independently revalidate identity, tenant, policy and intended watch.
    return null;
  },
});
// Only available if the host actually approved each watch.
// NEVER treat the result as permission to resume or deploy.
```

## Invariants and unresolved constraints

- An absent or incorrect old source-version claim, mismatched snapshot,
  invalid v1 definition, missing owner, in-flight/claimed/dead-letter delivery,
  unproved delivered receipt, denied host authorization or existing target
  means **failure**. The original old data is not modified.
- A failed candidate build cleans up only its exclusively created target.
  If the target path already existed, it is neither rewritten nor removed.
- Old Pattern signatures, candidate states, negative deadlines, event-time
  history, audit chain, source checkpoint/cursor and old wake/receipt IDs
  are deliberately **NOT copied**. This is a *new state*, not a compatible
  continuation of the old processor.
- Even a paused quarantine v1 store can eventually be resumed by a host.
  Its manifest is **NOT enforced by published v1.0.0 runtime**. Never use
  the candidate as a live Home or call trigger resume until a **separate
  exact-head verified host replay/receipt reconciliation gate** exists.
- Without a trustworthy provider-side frontier and host receipt ledger,
  a replayed historical event could create a *new* v1 wake ID and duplicate
  an old external effect. This helper has **NOT solved that problem**.
- `authorizeWatch` is an explicit **host-owned** call. Returning an
  authority object does not itself prove that external identity/consent was
  checked; operators must provide that evidence.
- Version, quiescence and full Home backup cannot be proven from the old
  JSONL bytes. Real operator controls and full storage backups remain
  mandatory. No migration should happen by running `npm install`.

## Still missing to unblock Muffin #962

1. Fixture from the **compiled 0.11 Muffin adapter**, including a live
   watch and an actually delivered host `runtimeReceiptId`.
2. Trusted host receipt reconciliation plus source frontier/replay policy:
   old event -> **zero** duplicated effects, new eligible event -> **one**
   activation/wake, including a second restart.
3. Safe owner/tenant reauthorization, restored source capability discovery,
   pending/in-flight wakes policy, negative-CEP finality guard and rollback.
4. Separate reviewed, versioned release of EI, then a new pinned Muffin
   exact-head CI / independent maintainer verdict.

**Do not merge #962, deploy this candidate or claim successful migration
based on an offline paused reconstruction alone.**
