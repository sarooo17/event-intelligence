# PostgreSQL match-committed / wake-unclaimed recovery evidence

**Issue:** #47. This is a reproducible *single crash boundary*, not a full
chaos/soak or end-to-end event-loss SLO certification.

## Boundary and invariants

1. Store A on independent physical PG pool commits a valid Pattern v2 trigger
   and a `matched` result. There is **no** wake delivery or claim yet.
2. Pool A is terminated, discarding all its physical PostgreSQL sessions.
   This simulates a dead worker's DB connection, **not** an OS process SIGKILL,
   actual database failover or a provider crash.
3. Pool B and pool C are fresh, independent physical pools/stores in the same
   tenant, using a unique isolated PostgreSQL table prefix.
4. Pool B reads the durable match and begins host continuation delivery.
   Delivery is held at a deterministic promise barrier **after the durable
   wake claim**, while Pool C tries to deliver the same matched record.
5. Pool C must return `delivery_in_progress` without invoking the host effect.
   Pool B completes with a durable runtime receipt and marks match `fired`.
6. Pool C reads delivered receipt with `attemptCount:1`; replay of the
   persisted match is `already_fired`, and late reclaims return `null`.

All assertions exercise **actual** PG16 transactions, wake claim fencing,
trigger-match projection and CompositeWakeCoordinator. No model calls, event
provider RPCs, or real host TurnStore effects occur; the host continuation
here is an intentionally counted deterministic fake. Therefore this evidence
supports **database/claim-level at-most-one delivery attempt in the measured
case**, not exactly-once external side effects under a crash *after* delivery.

Run with `POSTGRES_URL` (CI executes via `npm run test:postgres`):
`node --test test/postgres-preclaim-crash-recovery.test.mjs`.
The test cleans all isolated tables in `finally` and never modifies an
existing operator schema.

## Coverage relative to #47

**Newly tested:** crash after match persisted but before any wake claim, fresh
independent DB sessions recovering and racing once, then durable receipt and
idempotent replay. Previously merged #69/#94/#106 cover claim-generation ABA,
wake lease takeover, and repeated connection-pool rebalance; those are separate
failure windows.

**Still absent:** injected crash between external host delivery and persisted
receipt, connection loss during exact cursor transaction, repeated independent
OS-process chaos soak, real PostgreSQL failover, large-scale 1k/10k/100k
benchmark results, or full RPO/RTO numbers. No #47 acceptance criterion should
be checked as completely satisfied by this one fixture.
