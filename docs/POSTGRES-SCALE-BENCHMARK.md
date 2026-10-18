# PostgreSQL durable-trigger scale workload — reproducible harness

Tracking [#47](https://github.com/sarooo17/event-intelligence/issues/47)
and [#21](https://github.com/sarooo17/event-intelligence/issues/21).

This CLI measures **real PostgreSQL durable state**, not the fast in-memory
Pattern AST microbenchmark. The `smoke` profile (16 triggers, four wakes) runs
in GitHub Actions against PostgreSQL 16. It is a harness correctness check,
**not** proof of 1,000–100,000 production-scale capacity.

## Run

Use a dedicated PostgreSQL database with a disposable benchmark account and
backups/snapshots managed by its operator. The benchmark generates a random,
uniquely prefixed collection of tables and removes **only those tables** when
finished. It does not touch a production tenant scope or reuse a live table
prefix. Never run performance evidence against production data.

```bash
npm ci --ignore-scripts
npm run build
npm install --no-save --ignore-scripts pg@8

export POSTGRES_URL='postgresql://.../disposable_ei_benchmark_db'
export EI_PG_BENCHMARK_CONFIRM=YES_ISOLATED
node scripts/evidence/postgres-durable-scale.mjs --profile smoke
node scripts/evidence/postgres-durable-scale.mjs --profile 1k
node scripts/evidence/postgres-durable-scale.mjs --profile 10k
node scripts/evidence/postgres-durable-scale.mjs --profile 100k
```

All four profiles have a strict known trigger count: 16/1,000/10,000/100,000.
Optional `--concurrency 4` (1–16) controls bounded registration workers and
`--wakes 128` controls sample size (1–1000); smoke uses four wakes.

## Workload and output

- `register`: writes and validates N canonical condition-only Pattern v2
  triggers using `PostgresEventStore.putTrigger()`; latency distributions and
  wall-clock throughput are collected
- `listAll`: three authoritative `listTriggers()` operations and verified
  complete durable row count, including any observed cost of N-way reads
- `wakeEnsure`, `wakeClaim`, `wakeComplete`: durable store operations
  covering claim attempts and receipt generation; every wake must reach the
  delivered state
- `storageBytes`: actual PostgreSQL relation/table/index sizes; process CPU,
  heap/RSS and Node/Postgres versions are recorded

The JSON result has schema `event-intelligence.postgres-durable-scale.v1` and
records p50/p95/p99/max/mean, observation counts, duration, throughput and
runtime information. A `status: "completed"` report is emitted **only after**
temporary table cleanup and pool close succeed. Configuration, driver,
database, workload, cleanup and connection-close failures produce a structured
`status: "failed"` record on stderr with a phase, code and error list; a run
that leaves temporary tables behind is never reported as completed. Save raw stdout plus hardware/container/database specs
alongside the report. A failed run prints machine-readable phase/error data
and exits nonzero — failures are data too.

## Important limits

This benchmark **does not measure** provider event transport latency,
ingest-to-match, match-to-wake through the full runtime, host agent delivery,
end-to-end wake latency, event loss under network partitions, or
high-cardinality Pattern partition churn. It does not establish SLOs or RPO/RTO,
and a passed smoke profile does not imply a passed 100k run. The sample sizes
and workload distributions are intentionally disclosed; any interpretation
must separate database registration/list/wake costs from full system latency.

Before closing #47/#21, run the complete profile matrix on disclosed hardware
and independently measure ingress, partition correlation, crash/rebalance and
end-to-end delivery at several event rates. Attach generated JSON, failures,
CI artifacts and workload-specific SLO criteria. There is no claim of 100k
readiness merely because the harness accepts a `100k` flag.

## Explicit real PostgreSQL scale-evidence runs

The **PostgreSQL Scale Evidence** workflow offers explicit 1k, 10k
and 100k manual inputs. A PR which changes the benchmark workflow itself
also launches a **real three-job matrix** of the 1k, 10k and 100k
profiles. Each has 32 wake operations, concurrency=4 and a **separately
isolated PostgreSQL 16 service/database**. Hardware and raw JSON results
from each profile are uploaded as independent 90-day artifacts, including
stderr and failure records. A profile whose job fails or never completes
is **not** counted as measured capacity. Only the actual run IDs and
artifacts establish whether this exercise really happened.

The PR trigger deliberately watches **only benchmark workflow YAML**.
Ordinary application PRs do not pay for this matrix. For a manual dispatch,
the owner still chooses **one** explicit profile. A PR check that never
ran or failed must be reported as such; use exact run IDs and artifacts
before claiming any measurement. A successful 100k durable registration
profile is **not** a claim of production 100k event throughput, CEP
ingest-to-match SLO, host delivery or resilience. It creates a fresh PostgreSQL 16 service, records hardware
characteristics, runs the same isolated benchmark, and uploads JSON results,
stderr failures and host specifications as a 90-day artifact.

The 100k profile is automatically evaluated **only** in a PR editing
this explicit benchmark-workflow file. On other commits it still requires
manual opt-in. Merely configuring the matrix does not prove success:
cite each completed CI job/artifact, disclose runner/PG version and include
failures. Save artifacts externally before expiry.


## Actual-profile evidence aggregation (issue #47, partial)

After completing *real* isolated 1k, 10k and 100k runs, retain all three
raw `benchmark-result.json` files and `benchmark-host.txt` hardware reports.
The additive tool consumes only actual completed outputs:

```sh
node scripts/evidence/postgres-scale-matrix.mjs \
  1k-benchmark-result.json 10k-benchmark-result.json 100k-benchmark-result.json \
  > postgres-scale-matrix.json
```

The script validates exact reported trigger counts, durable list counts,
nonnegative p50/p95/p99/max metrics, actual wake samples and storage usage.
Duplicate/malformed or failed runs are rejected, not used as successful
evidence. Results from different commits or different reported Node/PostgreSQL
versions are marked `incomplete-provenance`. A missing profile is listed
explicitly as `incomplete-profiles`. The manual GitHub benchmark workflow
now captures a **one-profile** report along with each raw result; it cannot
report the other two profiles as measured merely because its own run passed.

Even `profiles-observed` is **not** production certification:
`productionSloCertified` remains false. This benchmark measures durable
registration/list/wake operations, not full provider-to-match latency,
physical host equivalence, high-cardinality pipeline throughput,
multiworker chaos, RPO/RTO or production readiness. Hardware logs and
full raw artifacts must be reviewed separately against agreed SLOs.
CI unit tests use explicitly synthetic shapes and never substitute for
running 1k/10k/100k PostgreSQL workloads.

## Full-matrix CI artifact for actual PR benchmark runs

The same benchmark-only PR workflow has a separate `aggregate-actual-profiles`
job. It downloads the **raw results of its own run ID**, one per actual 1k,
10k and 100k Postgres job, and runs the existing fail-closed
`postgres-scale-matrix.mjs` validator across all three records. The aggregate
job runs after the profile jobs **even when one failed**, so missing raw files
or invalid/failed profile data fail its validation instead of being silently
replaced with synthetic data.

Only `status: profiles-observed`, no missing profiles, matching reported
Node/PostgreSQL/platform/arch/concurrency versions, a single test checkout
commit, and `productionSloCertified: false` are accepted. The machine-
readable `actual-postgres-scale-matrix.json` is archived for 90 days under
`ei-postgres-scale-matrix-<run_id>`. A pass certifies only that all three
**store-operation benchmarks were actually observed and comparable by the
stated fields**; it does **not** certify runner hardware equivalence, provider
traffic, CEP matching throughput or a production SLO. Hardware logs remain in
each underlying profile artifact.
