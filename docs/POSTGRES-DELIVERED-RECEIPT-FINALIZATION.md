# PostgreSQL receipt-persisted / EI-finalization recovery (#47)

This deterministic real PostgreSQL16 test fills a previously missing
*internal* crash-boundary proof in
`CompositeWakeCoordinator.deliveredResult()`.

Two independent matches are prepared, then normal PG durable wake
claim/complete operations commit a **delivered wake receipt** at attempt
generation 1. Both cases first persist the normal **queued** WakeRecord
(the real coordinator always writes it before calling the external host).
The first case then omits the **delivered** WakeRecord; the second includes
that delivered WakeRecord but leaves the trigger match in `matched` state.
These are the two possible internal interruptions **after EI's receipt
write but before full finalization**.

The first physical PostgreSQL connection pool closes, and a second
independent pool reconstructs the coordinator and canonical trigger
engine. It must:
- Discover both inconsistent delivered receipts through the due-wake
  recovery query.
- Recreate only a missing delivered WakeRecord, preserving the
  authoritative host receipt ID; not append a duplicate existing
  WakeRecord.
- Mark both matches `fired` with the deterministic same wake ID.
- Never call the host deliverer again or increment the durable
  `attemptCount` beyond 1.
- Return `already_fired` on subsequent duplicate handling.
- Retain a valid audit chain; verify **one queued and one delivered**
  WakeRecord history row per wake, not just one total history row.
- Run the first recovery case through **two separate PostgreSQL pools**
  simultaneously with a forced read barrier: both coordinators see the
  queued-only history, but at most one can append the delivered record.

**Race fix:** the PostgreSQL store now provides an advisory-transaction-
locked `appendDeliveredWakeIfMissing` operation (scope + wake ID), used
by both recovery and normal successful delivery paths. It checks existing
**delivered** history before append, without a schema migration or deleting
the queued/audit evidence; only the winner emits delivery audit/telemetry.
Other adapters retain their prior local semantics; this test does not prove
distributed atomicity for non-PostgreSQL stores.

**Limits:** this is a deliberately constructed intermediate durable
state with fresh real PG pools, not an actual SIGKILL or network
partition at the precise receipt-write instruction. It does not cover
a remote host effect before EI receives the receipt (that is a
separate, idempotent-host boundary in PR #211), nor durable host
authorization, general exactly-once, 24-hour soak or production RPO/RTO.

The coordinator and PostgreSQL adapter are modified to close the genuine
horizontal-recovery race. No SQL schema, regex handling, npm publication
or consumer integration is modified. #47 remains OPEN.
