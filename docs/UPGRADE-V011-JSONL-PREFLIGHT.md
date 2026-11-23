# EI 0.11.0 → 1.x JSONL recovery: read-only preflight (draft #426)

> **Not a migration.** This work-in-progress source-branch tool does not appear
> in published `mcp-event-intelligence@1.0.0` and does not make a historical
> Muffin Home compatible with that package. The v1 signature guard must remain
> in place. Never add a signature marker to old populated state manually.

## Why the current upgrade cannot just change the npm dependency

[Maintainer reproduction in Muffin #962](https://github.com/muffin-project/muffin-agent/pull/962#issuecomment-7047403711)
and [EI #427 old-package CI](https://github.com/sarooo17/event-intelligence/pull/427)
both show that old Pattern v2 watches use a different persisted candidate
signature. v1 rejects populated unmarked JSONL state **before** loading it.
An old delivered EI wake ID and host `runtimeReceiptId` must not be
reinterpreted or redelivered as a new effect, and an old opaque MCP cursor
does not guarantee that a new processor can safely resume/replay every event.

## Operator procedure — read-only inventory only

1. Identify the exact package version **from a trusted host dependency lock
   or installed package manifest**, not from JSONL bytes: the old JSONL files
   do not authenticate which npm version generated them.
2. **Stop/fence all EI host/MCP/wake writers** that share this JSONL directory.
   No rolling/mixed-version workers are supported. Preserve host-owned
   receipt/Turn records as well as the EI JSONL directory.
3. Make a verified, restricted-access full backup of the **entire original
   Home**, not just `triggers.jsonl`, and put an independent *read-only copy*
   in a private, offline/isolated test environment. Never upload actual Home
   data, receipt IDs, credentials or event contents to a PR/CI.
4. From a checkout of the PR #427 source branch, execute:

   ```sh
   node scripts/upgrade-v011-jsonl-preflight.mjs \
     --dir /isolated/copy/event-intelligence \
     --source-version 0.11.0
   ```

5. Expect **exit code 2**, `status: "blocked"` and a JSON report containing
   aggregate counts, reason codes, and an overall SHA-256 of the inventory.
   Exit 2 is intentional even when no individual corrupt record is found:
   inspecting old state **cannot authorize migration**. If the reader rejects
   a source, its structured `errorCode` does not echo sensitive file content.
6. Reconcile every reported blocker before any approved recovery:
   - old watch ownership/scope must be reauthorized by the host;
   - completed host receipts must be checked against the independent durable
     Turn/effect ledger; pending/claimed wakes need a terminal decision;
   - source cursors, unresolved gaps, window/negative deadlines, candidate
     history and match IDs cannot be copied blind across signature versions;
   - without authoritative source replay/completeness, new watches may miss
     events or re-trigger old ones. **Abort** instead of claiming lossless
     replay. A fresh reset is explicitly lossy and requires owner approval.
7. Keep original 0.11.0 runtime and original immutable Home as the rollback
   candidate. **Do not start v1 against original populated old JSONL.**

## What the preflight actually checks

- Exact declared `0.11.0` source version; no claim to prove it from files.
- Root default scope plus canonical base64url scope directories; no symlink,
  unknown file, non-regular entry, v1 marker, oversized JSONL, malformed row
  or unexpected trigger/receipt state is accepted.
- Latest append-only wake receipt states (delivered vs pending/claimed);
  invalid delivered host receipts flagged.
- Current trigger versions, active/paused and missing owner binding,
  existing source cursor updates, event sources, temporal/match history,
  derived contracts, audit/wake records and safe aggregate counts.
- Full two-pass file SHA inventory to catch ordinary concurrent mutations.
  It is **not** a filesystem lock or a guarantee that writers are quiesced.
- No payloads or raw owner IDs appear in the JSON report. Scope names may
  be sensitive tenant identifiers: keep reports private unless redacted.

## Next required acceptance

[EI #426](https://github.com/sarooo17/event-intelligence/issues/426)
requires an **actual compiled old Muffin adapter** test with historical
wake + prior delivered host effect, followed by an explicitly authorized
migration/reconstruction into a *new* v1 store and cold-start validation:
old event **zero duplicate** external effects; one new eligible event **one**
wake, second restart, true owner isolation and reversible rollback.

Until that evidence exists, this read-only inventory and the passing
old-vs-new failure reproduction are only **negative controls**. Keep
[Muffin PR #962](https://github.com/muffin-project/muffin-agent/pull/962)
Draft and do not claim a safe v0.11 → v1 in-place upgrade or deploy.
