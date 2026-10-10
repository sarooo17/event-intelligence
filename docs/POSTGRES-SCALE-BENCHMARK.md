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
runtime information. Save raw stdout plus hardware/container/database specs
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

## Manual raw-evidence GitHub Actions runs

The **PostgreSQL Scale Evidence (manual)** workflow offers explicit 1k, 10k
and 100k inputs. It creates a fresh PostgreSQL 16 service, records hardware
characteristics, runs the same isolated benchmark, and uploads JSON results,
stderr failures and host specifications as a 90-day artifact.

The workflow is `workflow_dispatch` only: it does not run 100k workloads
automatically on every PR, and its presence does not mean any large profile
has been executed. Save artifacts externally before their retention expires
if they are used as release acceptance evidence.
