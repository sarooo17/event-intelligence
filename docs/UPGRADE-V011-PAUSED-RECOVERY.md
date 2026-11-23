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

## Compiled Muffin evidence: real old adapter and source-fence limitation

The opt-in `legacy-compiled-muffin-upgrade` CI job checks out **two
pinned, compiled Muffin source revisions**: upstream old
`dev@1a3a187f347552000ea8f139c9c54cd8258fa371` with the published
EI **0.11.0**, and the draft upgrade branch at
`df2160632955078502d50c218b65ecff1d979d68` with published EI
**1.0.0**. It does NOT link the old adapter against current EI sources
or fabricate a v0.11 persistent trigger record.

`test/muffin-compiled-v011-upgrade.test.mjs` uses the actual compiled old
`createMuffinEventIntelligence()`, its portable watch-create tool, and a
synthetic MCP polling source. It writes an old host receipt through a
file-backed fixture port and verifies the actual old EI delivered receipt
across cold restart. The new compiled adapter refuses an unchanged full
old Home clone; paused-only reconstruction works in a separate new Home
and delivers **zero** old effects across two startup cycles.

The test also includes an *explicitly controlled isolated* active-replay
scenario. Its fixture knows that source event IDs are **stable and
complete** for the old receipt archive, extracts the old `eventId` from
the **real old v0.11 `mcp-events.jsonl`**, and filters that ID before the
new v1 adapter can see source replay. It then verifies one new occurrence
enqueues **exactly one** additional host work item, and replaying the
same old+new occurrences after another restart adds **zero** items.
**This is a controlled source-fence proof, not a provider guarantee.**
The active copy is throwaway and is NOT the staged quarantine or a
generic migration. There is no production source replay filter yet.

`test/muffin-compiled-v011-real-turn-store.test.mjs` strengthens
the historical host evidence by executing the compiled old adapter
through Muffin's **real TurnStore**, with an owner-authored source Turn,
a `system:automation` wake, and its durable SQLite-backed Turn receipt
reopened cold. It independently proves the published v1 adapter rejects
a clone of the old EI Home unmodified.

### Safety boundary and why the final gate is still open

- The simple file-backed host port of the first scenario is **not** the
  real Muffin TurnStore. The second test validates old Muffin TurnStore
  durability but does not yet demonstrate a live reconciler spanning the
  old/new TurnStore and the source frontiers during a full cutover.
- A genuine MCP source might replay a prior logical occurrence with a
  **different event ID**, retain only partial history, or give a stale /
  unbounded cursor. In those cases the fixture's source-ID filter is
  insufficient: **stop and refuse the cutover**, rather than silently
  duplicating or dropping work.
- The staged v1 candidate remains **paused and
  `safeToResumeOrDeploy:false`**. All active replay is a synthetic
  isolated test, not an operator command or public API that could
  accidentally enable old watches.

**Muffin PR #962 stays Draft.** Upstream maintainer review and a concrete
host-owned replay frontier / receipt-reconciliation implementation remain
necessary before advising real owners to upgrade their populated Home.
