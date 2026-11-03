# E47-C — indexed audit head append (PostgreSQL16)

## Observed sustained-load bottleneck

The two real, **FAILED** first-party 1,000-trigger/1,000-event,
5 offered events/s Railway staging campaigns are preserved in
[issue #376](https://github.com/sarooo17/event-intelligence/issues/376).
At in-flight worker caps 8 and 20, 760 and 773 worker requests were
accepted respectively; remaining source appends were explicitly
**refused by the bounded test runner**. The cap-20 request-completion
time p50/p95/p99 was 2,330.874/10,284.510/11,657.968 ms. This
is not a passing capacity or production SLO claim.

On the cap-20 original scope, a **read-only** Railway PG16 profiler
showed 3,865 retained audit records (sequences 0–3864) occupying
2,783,360 bytes of JSONB payload. The existing
`PostgresEventStore.appendAudit()` took a scope-local advisory
transaction lock, read **all** previous audit records into Node,
parsed them with Zod, constructed `AuditChain`, computed one new
record, and then inserted one physical history row. Every match,
wake, lifecycle update and callback audit therefore repeatedly
transferred/parses the growing tenant-wide audit history while the
writer lock was held. This is quadratic cumulative history work and
serializes multi-worker progress.

The same read-only PG16 sample:
- `SELECT payload ... ORDER BY history_id DESC LIMIT 1`: **1**
  row, 1.954 ms, 1 shared buffer hit and 3 read blocks
- Existing all-history `SELECT payload ...`: **3,865** rows,
  4.113 ms server execution, 616 shared hits and 482 read blocks,
  **before** transferring 2.78 MB to Node and reparsing each record

These were one-off *post-run* plans, not paired or continuous workload
timings. They demonstrate an avoidable asymptotic hot-path cost, but do
not establish that removing it alone makes the 1,000-event campaign
pass. Also, the separate candidate-selection and wake-retry query
on the failed scope measured 4.761/13.026 ms at idle, respectively;
neither alone explains p99 worker latency above 11 seconds.

## Change and invariants

- **No audit row deletion, schema change or new trust boundary.**
  The existing index `(scope_id,kind,history_id)` selects the physical
  most recent per-scope audit record under the **same transaction-scoped
  PostgreSQL advisory lock** shared with every append (all workers).
  The next sequence is predecessor.sequence + 1, with genesis sequence
  zero and null predecessor. No global or cross-tenant memoized head.
- Extract `buildAuditRecordAt()` to share the **exact** original
  `AuditChain.append()` canonical serialization, transition guard,
  SHA-256 hash and schema parsing. Preserve `AuditChain.append()` and
  its callers unchanged.
- The new PG append also recomputes and verifies the terminal stored
  record hash before extending its chain; corrupt tails fail closed.
  This is **not** a full-chain verification: `verifyAudit()` and
  `getAuditCheckpoint()` continue to scan/validate from genesis,
  and off-host signed WORM checkpoints are still needed for independent
  integrity certification. Note that the old constructor only parsed
  records; it did *not* verify the historical chain on each append.
- PostgreSQL16 tests exercise two independent pools and concurrent
  writers for a single scope, genesis/sequence/hash parity against an
  in-memory canonical chain, cross-scope isolation, a deliberately
  corrupted terminal row, rollback/recovery, explicit full-chain
  verification and rejection of returning to full-history hydration.
  Separate pure tests ensure byte-for-byte canonical compatibility
  and invalid sequence/predecessor rejection.

## Acceptance boundary

This patch is a *performance optimization to be verified under
workload*, not proof of E47-C capacity or E47-A WORM retention.
After green exact-head CI, security review and clean-room tests, run
one **fresh** isolated Railway 1k-trigger/1k-event 5/s cap20 cohort
with an exact pinned reviewed commit. All source/worker offers and
actual durable receipts must still reconcile; backpressure is a
failed run. Do not reuse an already-failed scope, silently retry 227
refused events, or claim independent business provider/host coverage.
10k/100k and two-rate cohorts, PG physical CPU/IO isolation, fault
injection, independently pinned signed raw artifacts and enterprise
operator signoff remain pending.
