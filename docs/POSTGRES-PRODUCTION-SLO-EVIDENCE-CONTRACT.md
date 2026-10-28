# PostgreSQL production SLO evidence contract — candidate pre-signoff gate (#47)

**Status: UNPROVEN.** PR introduces an evidence completeness validator,
not production throughput, response-time or durability certification.
The previous 1k/10k/100k published synthetic results are valid bounded
**benchmark reporting evidence** only; their small p99 sample counts,
in-process host and absent provider transport cannot satisfy this contract.

## Procedure (freeze budgets BEFORE executing a study)

1. Choose hardware, PG 16 configuration, persisted trigger population,
   event rates, worker count, partitions, contention, real provider transport,
   external host callback and a full isolation/cleanup plan. Write down
   *workload-specific* p99 budgets for provider→ingest, EI ingest→match,
   match→wake and **external host effect** plus minimum accepted throughput
   and duplicate rate. Record budget registration timestamp before any run.
   Each steady/burst/fault-injected result now **must include canonical
   `startedAt` and `finishedAt` timestamps**; the SLO budget timestamp
   must predate every start, every finish must predate the final report's
   `observedAt`, and start→finish must agree with the reported duration
   within one second. An operator registering budgets after a workload but
   before assembling its report cannot pass the completeness checker.
   The gate intentionally does **not** invent universal milliseconds/second.
2. Run independent **steady**, **burst** and **fault-injected** workloads,
   each at least 600 seconds, with ≥2 real workers, ≥2 partitions and ≥1000
   verified wakes, recording ≥1000 real samples for **each** latency series.
   These minima merely establish a floor for useful empirical tails, not
   statistical confidence across all deployments. For fault-injected coverage,
   separately exercise worker termination, database interruption and partition
   rebalance; label failures rather than censoring results.
3. Persist raw public CI artifacts, exact source SHA, runner CPU/memory,
   Node, PG and driver versions, real achieved event rates, error/loss and
   duplicate-host-effect counts, both host and provider measured contributions
   and PostgreSQL-service resource use. A local fake host or replay-only
   harness cannot claim remote network/host measurements.
4. Reconcile the expected wake count against both PostgreSQL's persisted
   `delivered` wake-delivery rows and distinct host receipts after settlement;
   require zero due backlog, pending, and dead-letter deliveries. Then compare observed
   **verified durable wake throughput** (verified wakes / measured duration),
   measured per-metric p99, and duplicate host effects / verified wakes
   against the budgets frozen in step 1. Missing or mismatched accounting or
   exceeded budgets block review eligibility. The submitted aggregates are still untrusted
   declarations: a reviewer must recalculate them from retained raw samples.
5. Call `assessPostgresProductionSloEvidence(report)`. A valid report returns
   `eligible-for-independent-review`, **never `certified`**. The checker
   does not fetch artifacts or attest honesty. An independent reviewer must
   inspect raw measurement series, recompute aggregates and budgets, verify
   source provenance, timestamps, error rates and real-world infrastructure. Even a complete JSON report does NOT check #47/#21 automatically.

## Current evidence and limitations

- `scripts/evidence/postgres-mcp-ingest-wake.mjs` reports synthetic local
  ingest→wake and local callback timing, but **not** provider network or
  external host effects, and current profiles have too few samples for
  robust tail claims.
- `scripts/evidence/postgres-durable-scale.mjs` reports actual PostgreSQL
  registration/list/wake operations, but not multi-rate external E2E traffic.
- This validator fails closed for absent/malformed profile matrix, missing
  network/host/DB attribution, unregistered or **exceeded** p99, durable wake
  throughput and duplicate-effect budgets, insufficient p99 samples, missing
  loss/duplicate accounting and missing fault categories.
- A report claiming `productionSloCertified: true` is **rejected**:
  a human/independent performance signoff is mandatory, and the v1 release
  readiness ledger remains blocked until that verification exists.

**Compatibility:** additive evidence helper and regression tests only;
no runtime, persistence schema, MCP tools, provider integrations or package
publication changes. Test fixtures with synthetic `cpuModel` and URL
placeholders are *validator test inputs*, not benchmark results.

## Profile timing validation limitation (#47)

The static checker now rejects profiles missing per-run wall timestamps,
a start before pre-registered targets, malformed timezones/calendar days,
finish-before-start, runs finishing after the final report, and durations
inconsistent with elapsed wall time by more than one second. This closes
an earlier **retrospective-SLO-budget loophole** where `registeredAt`
only had to precede report creation, not actual workload execution.
Timezone offsets are normalized during comparison, not guessed.

These are still **untrusted report declarations**, not trusted timing
attestations or a hash of raw hardware logs. Independent review must
verify frozen SLO thresholds, event series and clock integrity against
preserved raw measurements. The report can only become
`eligible-for-independent-review`, never production certified, and
neither the existing 600s local workload nor this gate claims the
real provider + external host + PostgreSQL production SLO is met.

A duration statement rounded up from less than **600,000 real elapsed
milliseconds** fails, even when it differs from a reported 600 seconds by
under the one-second sampling/rounding tolerance. The 600-second floor
applies to actual start→finish wall time, not only a user-entered field.

## Full-window campaign load coverage (#287, child of #47)

The Railway validation benchmark rejects non-smoke steady/burst/fault
campaigns *before preparing triggers or the database workload* if their
configured event count is below `durationSeconds × requestedRatePerSecond`.
A default 600-second campaign at 10 attempted events/second therefore
requires at least 6,000 configured events. Large requested rates must be
explicitly reduced when the 250,000-event harness cap would be exceeded;
the harness cannot falsely represent the resulting smaller event budget
as an equivalent load rate.

After sending, the benchmark observes the **full monotonic 600-second wall
window** (including the final gap between scheduled five-second burst groups)
and records coverage failures as `completed-with-errors` if the real elapsed
window or attempted event count is insufficient. An explicitly stopped run
remains `stopped`. This proves only correct *campaign duration and attempt
coverage*: it does not imply successful delivery of all attempts or a
measured production SLO. Queue settlement, matched receipts, real network
provider latency, independent external host effects, genuine database HA
failure injection and immutable source/audit retention remain separately
unverified. The public v1 readiness ledger remains blocked.
