# EI 0.11.0 JSONL → v1: old host receipts and MCP replay frontier

> **DRAFT / offline and fail closed.** [EI #426](https://github.com/sarooo17/event-intelligence/issues/426) · [stacked PR #429](https://github.com/sarooo17/event-intelligence/pull/429).
>
> This is NOT an automatic migrator, verified provider adapter, real deployment
> plan or permission to resume a historical watch. It does not alter any old
> state or v1 quarantine. Do not run a mixed 0.11/v1 worker pool or bypass the
> v1 Pattern signature guard.

## What problem this solves

The published EI v1.0.0 correctly refuses old unmarked 0.11.0 populated
Pattern state. [PR #427](https://github.com/sarooo17/event-intelligence/pull/427)
proves that fact using the actual published old SDK and a fully compiled old
Muffin adapter. [PR #428](https://github.com/sarooo17/event-intelligence/pull/428)
can stage independently reauthorized watch **definitions** in a separate v1
store, but they stay paused and exclude all old receipts, match IDs and
event-time history.

A generic filtered old-`eventId` replay is **not safe** unless we also know:
1. the old delivered wake has a matching **authoritative durable host effect**;
2. the old MCP event archive and client cursor refer to **the same source**,
   with no omitted old occurrence IDs;
3. an independent *provider/host* guarantees stable, immutable event identity,
   complete replay through the old checkpoint, and no unreported gaps.

`prepareLegacyReceiptReplayFence()` implements the read-only preflight for
those exact assertions. It is NOT an independent verification of (3).

## What the gate actually checks

- Caller explicitly supplies declared source package `0.11.0`, a two-pass
  SHA-256 inventory digest from the read-only old-store preflight, the
  expected host runtime and tenant, and two external callbacks.
- **First supported profile only:** a quiesced, isolated, single
  `default`-scope JSONL store with **one** polling MCP source and empty source arguments.
  The old 0.11 client may persist an **internal polling subscription ID**;
  that exact ID must agree across all historical source-state records and
  archived occurrences. This does not authorize a push/webhook subscription. Multi-tenant scoped stores, multi-source,
  SSE, push and subscription handoffs currently **refuse**.
- **Every historical row for a wake** must preserve the same runtime,
  trigger, version, match and committed receipt identity; changing any
  previous delivered receipt ID is a hard refusal, even if the latest row
  looks valid. Every latest old wake delivery must be `delivered`, have nonempty
  trigger/match/version/receipt IDs, and map to one unique host receipt.
  Pending/claimed/dead-letter/unknown deliveries **refuse**.
- The host lookup must confirm the exact `receiptId`, `tenantId`,
  `runtime`, state `durable`, and the `system:automation` principal
  (the sample host is Muffin). The callback is responsible for reading
  its own independent durable ledger/TurnStore, never EI's JSONL.
- All old event occurrence records must have consecutive sequence numbers
  from 1, unique nonempty IDs, the same server and event name, and no
  subscription ambiguity. The old source cursor must be nonempty, polling
  and not marked truncated/errored. Historical source identity drift refuses.
- A separately provided, host-owned `attestProviderSource` callback must
  echo the exact source, old cursor, and SHA-256 digest of archived event IDs,
  and explicitly assert all four:
  `stableEventIds`, `immutableEventIdMapping`,
  `cursorPortableToTargetVersion`, `completeReplayThroughLegacyCursor`,
  `noUnreportedGaps`, plus `supportsPolling`. Missing/mismatched assertions refuse.
- Recheck the complete source SHA-256 after asynchronous callbacks; if any
  old byte changed, refuse. A digest is **not** a filesystem lock: the
  operator must physically stop/fence old writers and work on a full
  isolated clone.
- Before supplying the wrapped connection, reject any non-default scope,
  push stream or webhook callback. Discovery is constrained to the exact
  attested event type with `delivery: ['poll']`; unsupported event methods,
  multi-event discovery and nonempty polling arguments refuse, so no
  alternate transport can bypass the historical replay filter.
- When the caller separately and explicitly runs a simulated polling
  adapter, the **first new-v1 null request cursor is replaced with the old
  attested persisted cursor**: null would mean \"start from now\" and could
  silently lose downtime events. A subsequent non-null new-v1 cursor is
  forwarded unchanged. Archived old event IDs are filtered; new IDs pass.
  A null/omitted or `truncated: true` **provider response** refuses the cutover,
  as do unknown event names, invalid IDs or malformed poll requests.
  Old state, old cursor and new v1 store are never modified by this gate.

**Crucial trust distinction:** A host callback can *claim* provider
continuity; a boolean return value does not prove provider logs are complete.
EI cannot certify a third-party provider merely from its own event archive.
The returned plan therefore reports
`productionProviderIndependentlyCertified:false` and
`safeToResumeOrDeploy:false` even when the synthetic test succeeds.

## Evidence

The opt-in CI `legacy-compiled-muffin-upgrade` compiles source-pinned old
Muffin with published EI **0.11.0** and the draft Muffin upgrade with
published EI **1.0.0**. It:
- builds a watch via the old compiled Muffin tool, captures an actual
  old-EI-delivered wake and durable source cursor;
- separately validates the old wake against a **real cold-reopened
  Muffin SQLite TurnStore**, not just an in-memory receipt table;
- confirms direct v1 startup refuses the populated old Home without writing
  any source JSONL bytes;
- reconstructs a different v1 **paused** quarantine;
- in a *synthetic provider* that explicitly guarantees stable complete
  identities, filters the old occurrence, permits **one** genuinely new
  event to generate **one** wake, and verifies a second restart adds
  **zero** effects.

Negative tests cover missing host receipts, wrong tenant/principal,
source identity drift, incomplete/gapped archive, ambiguous polling
data, false provider attestation, in-flight old wake, and source byte
modification while the provider callback runs.

## Still necessary before Muffin #962 can merge

The operator/maintainer must choose an explicit supported
**lossy reset-and-recreate** recovery contract, prove provider completeness
against **a real source** with verifiable replay/cursor semantics, and
integrate the host callback and restart-safe source fence into Muffin's
real cutover sequence (with owner authorization, source discovery, backup,
rollback and refusal UX). Old Pattern in-flight candidates, negative CEP
deadlines and wakes require safe disposition; they are **not migrated**.

No automatic v1 marker rewrite, no silent cursor reset, no stale/partial
source acceptance, no real-user Home manipulation, and no package release
or PR merge as part of these tests.
