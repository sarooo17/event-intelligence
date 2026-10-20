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
4. Call `assessPostgresProductionSloEvidence(report)`. A valid report returns
   `eligible-for-independent-review`, **never `certified`**. The checker
   does not fetch artifacts or attest honesty. An independent reviewer must
   inspect raw measurement series, source provenance, budget timestamps,
   error rates, relevant real-world infrastructure and actual p99 vs frozen
   budgets. Even a complete JSON report does NOT check #47/#21 automatically.

## Current evidence and limitations

- `scripts/evidence/postgres-mcp-ingest-wake.mjs` reports synthetic local
  ingest→wake and local callback timing, but **not** provider network or
  external host effects, and current profiles have too few samples for
  robust tail claims.
- `scripts/evidence/postgres-durable-scale.mjs` reports actual PostgreSQL
  registration/list/wake operations, but not multi-rate external E2E traffic.
- This validator fails closed for absent/malformed profile matrix, missing
  network/host/DB attribution, unregistered budgets, insufficient p99
  samples, missing loss/duplicate accounting and missing fault categories.
- A report claiming `productionSloCertified: true` is **rejected**:
  a human/independent performance signoff is mandatory, and the v1 release
  readiness ledger remains blocked until that verification exists.

**Compatibility:** additive evidence helper and regression tests only;
no runtime, persistence schema, MCP tools, provider integrations or package
publication changes. Test fixtures with synthetic `cpuModel` and URL
placeholders are *validator test inputs*, not benchmark results.
