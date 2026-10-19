# Event Intelligence v1 candidate — public 1k / 10k / 100k benchmark report

**Observed:** October 19, 2026. **Classification:** bounded pre-v1 CI
evidence, **NOT** sustained production capacity certification. The
following run IDs and raw artifacts are public and reproducible in
GitHub Actions; a successful isolated test does not establish a
production p95/p99, availability or external-host exactly-once SLA.

## Source, hardware, raw artifacts

- **PG16 durable-store matrix:** [Actions run 39234715605](https://github.com/sarooo17/event-intelligence/actions/runs/39234715605), exact source commit
  ba22ef6c3ab70564248e938a0eea31985f156bb3, Node v22.23.3,
  PostgreSQL 16.15, Linux x64, pg 8.16.3. Jobs: isolated-1k
  118000896335, isolated-10k 118000896090, isolated-100k
  118000896818, aggregate 118001268430. All four concluded
  **success**, with separate isolated disposable PG16 instances.
  Artifacts on that run: ei-postgres-scale-{1k,10k,100k}-39234715605
  and ei-postgres-scale-matrix-39234715605. They contain the raw
  structured result, per-profile source SHA and host hardware dump.
  The aggregate says productionSloCertified=false.
- **Active MCP-shaped ingest → Pattern v2 → PG wake/receipt:**
  [1k matching run 39242169109](https://github.com/sarooo17/event-intelligence/actions/runs/39242169109);
  [10k/100k matching run 39242169321](https://github.com/sarooo17/event-intelligence/actions/runs/39242169321),
  exact head 89298a84562fe5a2fb3873ea98827160bd30ebe4, Node v22.23.3,
  PostgreSQL 16.15, Linux x64 and pinned pg 8.16.3.
  All five per-profile jobs concluded **success**. Raw JSON,
  error-log and host diagnostics are downloadable from each run's
  per-profile artifacts until GitHub retention expiry.
- **Historical comparison:** [pre-indexed/updated matching run 39237414663](https://github.com/sarooo17/event-intelligence/actions/runs/39237414663)
  and [indexed-wake run 39239306696](https://github.com/sarooo17/event-intelligence/actions/runs/39239306696).
  They support a directional improvement for the one-source
  synthetic fixture, **not** a controlled paired performance experiment.

The original GitHub runner hardware facts and all raw JSON are
included in the referenced CI artifacts. Do not substitute this
document for the artifacts, extrapolate from runner RAM to PG service
RAM, or silently discard failed trials. Artifact links may expire.

## A. Measured durable registration and storage

All definitions durably persisted and listed back. Four concurrent
registration workers, 32 synthetic wake claim/receipt cycles per
profile. Throughput is **registration/s**, not MCP occurrences/s.

| Definitions | Registered/s | List-all p95, ms (n=3) | PG relations bytes | Node RSS after |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 2,947.56 | 49.12 | 1,228,800 | 87,420,928 |
| 10,000 | 2,391.08 | 167.66 | 10,158,080 | 132,820,992 |
| 100,000 | 4,813.51 | 1,672.50 | 99,557,376 | 541,962,240 |

Registration rate is **not monotonic** across isolated hosted runners:
differences reflect workload/host scheduling and are not evidence
that 100k scales better than 10k. Full-registry list remains expensive
by design and should not be on the critical path of each wake
(indexed lookup #224 addresses that part).

## B. Measured active trigger match-to-wake (fixture host)

Each profile pre-registers all definitions into isolated PG16; the
events below travel the real CompositeEventConsumer, Pattern v2 engine,
authoritative PostgreSQL wake coordinator and a counted **local
fixture** host receipt, not through a remote provider/agent network.
The 10k/100k setup uses canonical-schema-validated direct PG seeding,
NOT the expensive engine.register cycle check, which is a distinct
registration API. Tests include nonmatching noise, an exact replay,
and fresh-pool receipt verification.

| Registered active definitions | Event names | Matching events n | Ingest→match p95, ms | Match→wake p95, ms | Ingest→wake p95, ms | False wakes / duplicate host effects |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1 | 16 | 42.26 | 25.07 | **65.35** | 0 / 0 |
| 1,000 | 20 | 16 | 37.99 | 24.25 | **60.58** | 0 / 0 |
| 10,000 | 1 | 8 | 82.54 | 25.99 | **108.53** | 0 / 0 |
| 100,000 | 1 | 2 | 654.45 | 20.61 | **675.06** | 0 / 0 |
| 100,000 | 20 | 2 | 447.99 | 22.52 | **470.51** | 0 / 0 |

The 100k runs have only **two samples**. Their reported p95/p99
are simply the slower of two events, **not statistically meaningful
latency percentiles**. The 10k n=8 and 1k n=16 tail values are still
too small for production SLO inference. Synthetic equality predicates
allow PG to reduce the 100k/one-source population to **one** returned
candidate; this is a narrow favorable workload, not arbitrary regex,
semantic or temporal multi-event correlation at 100k.

## Failures and negative results, not hidden

- **Selected final jobs:** zero failed profile jobs in the two
  referenced matrices. This means no observed job failures *in those
  specific runs*, not zero failures under representative operating load.
- **Regression and review history:** #223's initial 100k setup used an
  O(N²) full derived-event cycle scan through engine.register; later
  replaced with canonical-schema-validated direct seeding. #225 Codex
  identified JSONB NUL/surrogate and fractional/unsafe number
  edge cases, fixed and covered by real PG16 tests before merge.
  These were genuine implementation defects, **not** demonstrated
  100k capacity failures or event-loss observations.
- **Performance counterexample:** 100k spread over 20 event names
  regressed in the unpaired #224→#225 comparison: observed
  ingest→wake sample maximum **382.63 → 470.51 ms**, while the
  one-event-name 100k fixture improved **1,735.06 → 675.06 ms**.
  Avoid cherry-picking the favorable configuration as global speedup.
- **Not exercised in selected reports:** prolonged concurrent
  provider streams, high-cardinality partition windows and negatives,
  real network/DB disruption, slow host idempotency, queue buildup,
  backpressure/loss under sustained throughput, PostgreSQL service
  CPU/RSS/IO attribution and fault-injected p99. No RPO/RTO or SLO
  certified. Single-run values cannot set regression budgets.

## Reproduction commands

Use **a disposable PostgreSQL 16 database** with the optional pg
driver installed and built package. For durable storage:

    EI_PG_BENCHMARK_CONFIRM=YES_ISOLATED \
      node scripts/evidence/postgres-durable-scale.mjs \
      --profile 100k --wakes 32 --concurrency 4

For high-active matching (two 100k event samples, including noise
and replay):

    EI_PG_PIPELINE_CONFIRM=YES_ISOLATED \
    EI_PG_PIPELINE_LARGE_CONFIRM=YES_ISOLATED_LARGE \
      node scripts/evidence/postgres-mcp-ingest-wake.mjs \
      --triggers 100000 --events 2 --sources 1 \
      --noise 2 --replays 1

Set POSTGRES_URL to that disposable database in the environment.
The authoritative workflow YAML provides pinned CI versions and
concurrency/cost caps. Do not use customer/production databases.
If a test fails, publish the error log/structured failure artifact
alongside the successful profiles: missing profiles are not capacity
proof.

## Acceptance interpretation (#47)

This document is the **public actual-profile benchmark report with
failure limitations and machine-readable CI evidence**. It may
support the narrow top-level #47 benchmark-report acceptance, after
independent review. It does **not** fulfill the separate #47
production SLO/soak/retention acceptances, nor #21's transferred
high-cardinality and multi-rate sustained-throughput task.
All v1 release-readiness production gates stay blocked until those
independent requirements are completed and signed off.
