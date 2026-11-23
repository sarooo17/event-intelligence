# EI 0.11 → v1: host-owned durable gap and poll-checkpoint journal

**Status: stacked DRAFT PR #430, offline/synthetic only. NOT production cutover-ready.**

[Critical upgrade issue #426](https://github.com/sarooo17/event-intelligence/issues/426) ·
[Receipt and replay prerequisite #429](https://github.com/sarooo17/event-intelligence/pull/429) ·
[Paused-only candidate #428](https://github.com/sarooo17/event-intelligence/pull/428)

## Why this exists

In the first reconciliation prototype, a provider could report a truncated
backlog or no replay cursor and the source wrapper would remember it only in
process memory. SIGKILL/host restart could erase that fact, allowing a later
healthy-looking page to advance the v1 cursor while an old event gap remained
unresolved. The published EI v1 runtime cannot infer these old-format gaps
from a freshly rebuilt v1 candidate store.

`openLegacyHostGapJournal()`, in
`scripts/lib/v011-host-gap-journal.mjs`, is a **host-owned, single-worker,
fsync-backed intent journal** that can be optionally bound to the narrow
read-only replay fence from PR #429.

- Bind every journal to the **complete old source snapshot digest**, the
  archived event-ID digest, and the authorized host tenant. Files belong
  in a **separate host-owned directory**; NEVER in the old 0.11 EI store.
- Explicit `mode: 'create'` creates the initial journal with exclusive
  file creation. Reboot must use `mode: 'open'`. A missing, partially
  rewritten, mismatched, damaged or stale journal is an **error**, not a
  new permit.
- **Before** the first `events/poll` RPC, persist and `fsync` the
  `polling` intent and directory. If an actual SIGKILL occurs before the
  response, an independently cold-opened host sees `polling` and refuses.
- Once the provider response and archived-event filtering validate,
  persist `checkpoint-required` **before** handing the page to v1.
  The host must then read its real durable v1 MCP client checkpoint,
  compare its exact cursor, and call `confirmHostCheckpoint()`. That is
  the only transition back to `ready` and permission for a later poll.
  If the process dies after the page but before host commit, the journal
  stays `checkpoint-required` and refuses on cold restart.
- On provider errors, nonreplayable/null cursor, truncated/gap, malicious
  data or payload collision, persist `blocked` before rethrowing. A
  clean retry and new host instance cannot re-enable the source.
- Each transition is serialized **within one handle** and uses an atomic
  file rename, file `sync()`, then directory `sync()`. A leftover
  `.pending-...` file also blocks reboot rather than being silently
  deleted. The old source archive is never modified.
- There is **no reset or unblock method**, no migration marker forgery and
  no automatic owner watch resume. A blocked journal requires a separately
  approved recovery and new evidence.

## Tests / evidence boundaries

`test/v011-host-gap-journal.test.mjs` checks the cold-start state machine,
proof callback failures, wrong source and tenant binding, corrupt and
missing journal, leftover partial writes, and same-handle concurrency.

`test/v011-host-gap-journal-sigkill.test.mjs` actually kills a child Node
process with **SIGKILL after `beginPoll()` completes** and checks an
independent cold-reopened journal rejects future polling.

`test/v011-durable-replay-fence.test.mjs` binds the prior v0.11
receipt/source replay prerequisite and checks the host intent is durable
during a poll, that a valid page cannot permit another poll until verified
checkpoint readback, and that a reported source gap is still blocked after
cold restart.

The source-pinned compiled Muffin old/v1 fixture additionally exercises the
journal against **published EI v1's actual persistent MCP cursor**: close
the candidate runtime, reopen its v1 store, read its MCP source cursor, then
only confirm a matching host checkpoint. It verifies a new wake and
no duplicate old wake across restart in a **synthetic provider** with an
explicitly declared stable/complete replay boundary.

## What this does NOT establish

This is intentionally a **single host process / one writer** proof.
There is no external distributed lock, fencing epoch, CAS/DB transaction,
multi-worker partition ownership, or fleet deployment authorization.
The journal and EI JSONL are distinct resources: a host callback can
assert the checkpoint is durable but these files do not form one atomic
transaction. A crash while data or host effects are being committed can
remain an ambiguous outcome requiring operator intervention.

The source declaration in these tests is synthetic, not an independently
verified guarantee of any real MCP provider. Neither a valid journal nor
a passed fixture proves completeness through an arbitrary provider's
old opaque cursor, or lossless transfer of v0.11 Pattern candidates,
negative-CEP deadlines, claims, in-flight wakes, or source gaps.

**Required later work**: actual Muffin host integration and operator
approval UX; true one-writer or multiworker fencing and ownership;
real provider cursor/replay certification; full old-new TurnStore receipt
reconciliation under fault injection; rollback; reviewed versioned release.

Until then, keep `safeToResumeOrDeploy:false`, the quarantined watches
**paused**, PRs #427–#430 **Draft**, and Muffin PR #962 **Draft**.
No live Home is edited or migrated by these helpers.
