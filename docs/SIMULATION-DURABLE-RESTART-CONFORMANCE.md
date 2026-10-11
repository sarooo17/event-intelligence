# Virtual-clock simulator vs durable restart conformance

Partial acceptance evidence for [#46](https://github.com/sarooo17/event-intelligence/issues/46), not an extension of the public simulation API.

The test `test/simulation-durable-restart-parity.test.mjs` uses the **existing** `simulateTrigger()` and the regular durable `PersistentEventStore`, `CompositeTriggerEngine` and `TemporalDeadlineScheduler` with explicitly injected UTC clocks. It builds an absence condition ("email received, no reply for 30 minutes") with synthetic untrusted event data.

The same event is evaluated in two genuinely different paths:

1. Run the isolated simulator up to **deadline −1 ms** and then separately through the exact deadline. Re-run at that same clock, checking byte-identical simulation reports.
2. In a fresh temporary directory, register the same trigger, ingest once, and **reopen a new durable store and engine** before advancing to deadline −1 ms and the exact deadline. Run the actual temporal scheduler again at the deadline to assert no duplicate evaluation.

The tests compare deterministic public inspection projections: why code, match status, next evaluation, pending deadlines and source-event reference IDs. The fired deadline is verified directly in the authoritative persisted store because the inspector's final-match view only lists deadlines belonging to that final match; the predecessor partial-match deadline is not attached to it. They do **not** compare volatile/internal record IDs or clock-dependent audit record timestamps. No host wake handler, provider, OAuth credential, real network call or model is configured; the temporary store is deleted when the test completes. Raw event payload contents must not appear in inspection evidence.

Run against Node >=22:

```sh
npm ci
npm run build
node --test test/simulation-durable-restart-parity.test.mjs
```

**Boundaries:** This verifies one non-nested absence operator with an exact injected deadline and a local persisted store. It does not simulate a crash *inside* an append/transaction, distributed PostgreSQL leases, a real MCP session, schema migrations, or host-owned wake delivery/approval. This is evidence towards the #46 restart/simulation acceptance criterion, not a blanket production-recovery claim.
