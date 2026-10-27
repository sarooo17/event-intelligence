# Host-owned atomic receipt boundary — PostgreSQL conformance fixture

Implementation evidence for [#271](https://github.com/sarooo17/event-intelligence/issues/271)
and [#269](https://github.com/sarooo17/event-intelligence/issues/269).
This is **not** a new EI persistence layer, SDK, production host, or independent
third-party integration.

The existing `createActivationDispatcher()` already supplies stable candidate
receipt IDs, `hasReceipt` preflight, target resolution, delivery, and post-error
receipt reconciliation. Those operations **cannot atomically enqueue external
host work**; `hasReceipt` is only a lookup. Correct external delivery must use
a transaction/unique constraint/idempotent queue on the host side.

`test/postgres-host-receipt-boundary.test.mjs` is a reproducible **real
PostgreSQL 16** boundary example with two independent connection pools:

- An authoritative host-owned `targets` table resolves scope using opaque
  `target.id`; event/packet-supplied `scope_id` is not trusted.
- A host-owned `work` table represents a committed unit of queued work **and**
  its receipt in the *same atomic insert* (`receipt_id` primary key,
  `ON CONFLICT DO NOTHING`). In a real app this transaction must encompass
  the actual durable work enqueue or outbox effect.
- Eight simultaneous wake deliveries through **two independent connection
  pools** are deliberately synchronized before delivery; one work row commits.
- Identical wake IDs in distinct authoritative scopes yield independent
  receipt IDs, avoiding unsafe tenant-crossing deduplication.
- A post-commit/pre-ack injected failure is reconciled by querying the actual
  host-owned work table; a new pool after closing the first observes the same
  persisted receipt, without a second job.
- Revoked/deleted target lookup fails closed before first enqueue.

## Run

```bash
POSTGRES_URL=postgresql://... node --test test/postgres-host-receipt-boundary.test.mjs
```

The regular `postgres-ha` GitHub Actions job executes this test through
`npm run test:postgres`. It auto-skips without `POSTGRES_URL`, and does
not claim an on-host test when skipped.

## Limitations and ownership

This is EI-maintained evidence using actual PostgreSQL transactions. It is
**not** an independently-authored third-party host, two distinct operating
systems/processes, a live production work queue, or proof of distributed
host behavior under network partitions. Existing EI SIGKILL/PostgreSQL tests
cover EI's internal crash windows separately. The host must provide its own
transaction boundaries, receipt lookup, actor/owner/scope validation and
revocation policy. A callback reporting `runtimeReceiptId` is not itself a
durability guarantee; HostContract v1 is only configuration validation.
The test defines NO portable principal, Turn, graph, agent session, or
policy engine. Avoid copying the PostgreSQL implementation into the EI kit.
