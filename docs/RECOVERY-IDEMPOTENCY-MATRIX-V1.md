# v1 recovery and delivery guarantees — failure-boundary matrix (#47)

**Status: test-backed draft, not production SLO acceptance.** This
describes the current embedded EI runtime and the *host-owned* external
effects boundary. Tests mentioned here are reproducible evidence only
for the precise injected fault. They are not substitutes for production
failover, a live remote MCP source/agent, or a long soak.

## Exact contract

EI offers **at-least-once wake delivery attempts** under retry and
reclamation. A logical match has a deterministic wake ID. When the
host returns a durable receipt, EI stores the receipt and fences
subsequent worker claims. This is not a distributed transaction across
the host and EI.

**A host must deduplicate effects by stable `wake_id` within its own
authoritative target/tenant context** and durably return the *same*
receipt on a repeated wake. With such an idempotent host, the
observable host effect can be **effectively once**. Without it,
ambiguous failure *after* the external effect can repeat side effects;
EI cannot prove global exactly-once. Authorizations, ongoing policy,
target integrity, revoke/deny decisions and permissions remain with
the host on **every** attempt, including retries; a receipt alone is
not an authorization grant.

A `claimed` wake is unavailable to other worker IDs until the
persisted lease expires; reclaim increments `attemptCount` and
a stale attempt cannot complete or fail a successor claim, including
reuse of the original logical worker ID (ABA). A
`delivered` wake cannot be claimed again.

## Failure boundaries and evidence

| Failure window | Durable fact before interruption | Expected restart action | Current test evidence | Still unproven |
| --- | --- | --- | --- | --- |
| Provider event not yet persisted | Source retains responsibility for replay and cursor | Re-deliver source event if provider retains it; do not assume EI persisted it or acknowledged the source | [Real OS SIGKILL after fixture provider handoff, before EI ingestion](../test/postgres-provider-pre-ingest-sigkill.test.mjs), **merged #215**: three retained MCP-shaped events, real child-process death, recovered re-poll with stable provider IDs, one fired wake/effect per distinct source event and forced replay | Remote MCP provider/webhook delivery, interrupted transaction *inside* EI.ingest, producer replay/retention bounds, network failure or upstream event loss |
| After ingest and durable wake, before source cursor checkpoint | Fired match/receipt persisted; old cursor retained | Same provider ID is replayed; original fired match/wake/receipt is reused | [PG cursor pre-ack pool restart](../test/postgres-cursor-pre-ack-recovery.test.mjs), merged #205 | Real polling network, cursor/ack crash atomicity, remote host exactly-once |
| After match committed, before wake claim | Matched trigger record persists; delivery may be absent | New worker recovers same logical match and competes for one wake claim | [PG independent pools preclaim recovery](../test/postgres-preclaim-crash-recovery.test.mjs) | Process/network failure at this exact phase with remote host |
| After wake and partition claim, **before host effect** | Claim/owner/generation are durable; no receipt | Reclaim only after lease expiry; reject old generation, then complete as new worker | [Six real OS SIGKILL rounds](../test/postgres-os-sigkill-recovery.test.mjs), merged #210 | Real clock waiting, sustained failover, external host |
| **After host effect**, before EI receipt | Host side effect exists, EI claim unresolved | Retry after lease expiry; host must return original receipt for same `wake_id` without another effect | [Real SIGKILL after host effect](../test/postgres-post-host-effect-sigkill.test.mjs), **merged PR #211** | Real remote host/HTTP TurnStore, unknown non-idempotent hosts, external transaction coordination |
| After EI receipt committed, before durable wake record append / match marked fired | `wake_delivery.status=delivered`; match may still be `matched` | Coordinator must reconstruct wake and finalize match without host redispatch; competing PG workers append at most one delivered history row | [PG receipt/finalization recovery test](../test/postgres-delivered-receipt-finalization.test.mjs), **merged #213**, with independent-pool race barrier; [OS SIGKILL receipt-commit test](../test/postgres-post-receipt-sigkill.test.mjs), **PR #216 pending review/merge**, not yet accepted as merged evidence | Exact post-receipt OS SIGKILL until #216 passes final review and merge; remote host, cross-adapter distributed atomicity and production failover |
| Multiple contenders during wake delivery and lease expiry | One active claim generation at a time; partition lease separated | Losers return in-progress/claim-lost; only rightful generation may write receipt | [PG shared-state arbitration](../test/postgres-shared-state.test.mjs), [reconnect/rebalance](../test/postgres-rebalance-reconnect.test.mjs) | Sustained multiworker overload, network partitions and chaotic interleaving |
| After delivered receipt, provider replay or new worker | Delivery and fired state persist | Reuse delivery/receipt, no redispatch; never reset receipt based only on elapsed time | [PG cursor replay](../test/postgres-cursor-pre-ack-recovery.test.mjs), [PG SIGKILL recovery](../test/postgres-os-sigkill-recovery.test.mjs) | Retention/compaction beyond receipt lifetime, real host replay after restore |
| Host permission revoked after queuing | Durable wake exists but host permission can change | Every retry must re-check host permission; deny without external action | [Queued host revocation test](../test/queued-wake-host-revocation.test.mjs) | Real remote host and complex RBAC policy changes |

## Operational constraints

- **Receipts cannot be pruned merely because they are old.** EI wake dedup,
  provenance/audit and a host's idempotency retention window need a
  jointly defined policy. The existing bounded semantic-cache TTL is
  *not* a safe general event/match/audit compaction policy.
- **Do not advance an MCP source cursor before durable processing** and
  blindly assume a source can replay forever. Cursor semantics and
  producer retention must be explicit; reconcile gaps when replay is
  impossible.
- **Fail closed on incompatible PostgreSQL schema versions.** Reusing
  old trigger/wake history without an intentional reset/restore is not
  a supported migration. Back up and verify immutable evidence before
  operator-controlled reset. Do not assume mixed-version workers.
- **Max attempts/dead-letter** are bounded failure outcomes, not
  exactly-once proof or successful host execution. Alert operators on
  terminal failures and unresolved receipt ambiguity.
- **Lease expiration is not external cancellation.** A worker may be
  suspended, a host may have committed an effect, or acknowledgments
  may be delayed. Generation fencing protects EI state, **not** the
  external host's non-idempotent operations.
- Do not derive production RPO/RTO from synthetic-clock test durations.

## Remaining v1 acceptance

This document classifies the above boundaries, but **does not check
off all of issue #47**. The provider-pre-ingest OS-kill fixture merged in
#215; the narrower post-EI-receipt OS-kill PR #216 is a **candidate** until
its latest-head independent review and merge. The merged #213 fixture only
injected intermediate durable states and closed the original PG pool.
Required next: accept or fix #216 without overclaiming remote-host proof,
production-like host idempotency/authorization contract verification,
true repeated
partition/network faults, multiple event-rate/high-cardinality worker
soak, retention/compaction with audit-chain integrity, and
environment-specific SLO/RPO/RTO with complete raw evidence.

This document does not change package API, DB schema, regex behavior,
Muffin/Artemis integration, or any npm release.
