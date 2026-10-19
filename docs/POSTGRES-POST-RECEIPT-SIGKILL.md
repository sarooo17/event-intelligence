# Actual SIGKILL between committed EI receipt and wake finalization (#47)

This test closes the remaining *process-disruption* qualification for the
post-EI-receipt/pre-wake-finalization boundary from PR #213.

In each of three rounds, a real child Node process uses a separate
PostgreSQL pool and canonical CompositeWakeCoordinator, starts from a
durable Pattern v2 match, and invokes a fixture-owned host callback.
The callback commits one independent host-effect record keyed by stable
EI wake ID and returns a matching stable receipt.

A **test-only wrapper** around PostgresEventStore.completeWakeDelivery()
awaits the **actual committed PostgreSQL transaction** and sends an IPC
checkpoint, but blocks before allowing the coordinator to append its
delivered WakeRecord or mark the match fired. The parent checks that the
delivery is already status=delivered and the host effect is present,
while the latest EI WakeRecord remains queued and the match remains
matched. The parent then issues real OS SIGKILL and reaps the child.

A fresh independent Node process and pool reconstruct the coordinator,
sees the durable EI receipt, appends one delivered WakeRecord, and
marks the match fired. The host deliverer is a trap: ANY second call
is a test failure. A third process validates already_fired replay.
The test checks one queued and one delivered history row, unchanged
attemptCount=1 and runtime receipt, one external effect per wake,
no re-dispatch and valid PG audit chain.

**Limits:** The process SIGKILL is real and intentionally lands between
a committed PostgreSQL receipt and the next coordinator instruction.
The exact boundary is created via a test-owned function wrapper rather
than randomized fault injection or a scheduler pause in production code.
The host is a PostgreSQL fixture, not a remote HTTP/TurnStore or MCP
runtime. No real DB failure, network partition, long soak, RPO/RTO/SLO,
global exactly-once or host authorization proof is claimed.

Run in real PG16 CI with npm run test:postgres. No production storage
schema, migration, regex, runtime API, release or downstream integration
is changed. #47 remains OPEN for remaining independent failover/scale
and retention acceptance criteria.
