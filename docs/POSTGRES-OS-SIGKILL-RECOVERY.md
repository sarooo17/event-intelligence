# Real SIGKILL recovery of claimed PostgreSQL wake and partition leases (#47)

This adds **six actual Linux Node child-process SIGKILL + successor process**
rounds in the existing real PostgreSQL16 integration CI suite, rather
than just closing and recreating a database connection pool.

The parent persists six independent fixture wake delivery records. In
each round an independent Node worker/PG pool **claims and commits** both
a wake lease and a partition lease, acknowledges that point through IPC,
then the parent sends real OS `SIGKILL` to the worker PID and verifies
the child actually exited because of that signal. A separate new process
then reclaims at the exact persisted lease expiry with attempt generation
2 and saves a synthetic *local* host receipt. A competing worker is
denied before expiry; a stale generation-1 completion is denied even
when the new OS process reuses the same logical worker identity (ABA).
Durably delivered wakes cannot be re-claimed. A third independent PG
pool audits all six receipts and final partition owners.

## Evidence

- `test/postgres-os-sigkill-recovery.test.mjs` in `npm run test:postgres`,
  which is the real PG16 Actions CI integration gate.
- `test/fixtures/postgres-os-sigkill-worker.mjs`, which uses a different
  physical Node process and its own PG pool. A deterministic IPC
  acknowledgement is emitted *after* database claims commit and before
  the kill; no time-dependent guess about where the child died.
- Six rounds with two logical successor identities, including same-ID
  ABA generation fencing; no sleeping a whole minute to simulate
  expiry. A synthetic **now timestamp** is supplied at the persisted
  lease boundary to test exact expiry semantics deterministically.
- Per-test isolated randomly named tables, complete teardown, bounded
  IPC deadlines, process cleanup on assertion failure, no external
  production state mutation.

## Critical limits

The actual OS process termination and independent successor are real,
but the **lease clock jump is simulated**. There is **no external host
delivery before SIGKILL**, and the successor receipt is synthetic.
This proves durable claim fencing and safe retry when killed *before*
the external host effect. It does not prove exactly-once remote host
side effects after an ambiguous external delivery, a full model/agent
resume, real MCP polling, long-running network partition, actual
production failover, queue SLOs or 24-hour chaos soak.

The test is repeatable rather than load/capacity-certified. It does
not change production code, schema, regex filters, npm publication,
Muffin, Artemis or the v1 release contract. #47 remains OPEN.
