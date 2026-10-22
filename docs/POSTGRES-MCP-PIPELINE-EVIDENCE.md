# Real PostgreSQL MCP occurrence → match → wake evidence (#47)

This new benchmark measures the actual `CompositeEventConsumer.ingestMcpOccurrence()`
pipeline against an isolated PostgreSQL 16 database:

`MCP-shaped occurrence (in memory) → safe normalization/hash → canonical
Pattern v2 engine → durable matched state → durable wake claim → EI wake
→ host-controlled callback receipt → durable fired/receipt state`.

It is **not** the previous 1k/10k/100k registration benchmark, or the
synthetic in-memory Pattern evaluator benchmark. The definition and match
processing execute in production EI code with real PostgreSQL IO.

## Workload and invariants

The benchmark CI jobs also trigger on production implementation changes
to Pattern v2, MCP event conversion, the composite consumer/wake
coordinator, and PostgreSQL storage. They are therefore a **small
correctness-regression gate** for changed measured code, not just a
manually requested report. This adds bounded CI cost (two isolated
PostgreSQL 16 jobs) to relevant source PRs; it still does not certify
production throughput or full host effects.

The GitHub Actions workflow
`.github/workflows/postgres-mcp-pipeline-evidence.yml` performs **two
separate isolated jobs**, currently 8 and 16 active durable triggers,
respectively. In each job:
- Every trigger watches the same event source/name, distinguished by a
  deterministic, valid `slot` predicate; matching input must fire exactly
  one logical match and one unique wake/host receipt.
- 4 unmatched events must have zero logical matches and wake effects.
- 2 exact source-event replays must be deduplicated: no second host effect.
- The callback is an in-process **fake host** that returns a stable receipt;
  the persisted PostgreSQL status is verified through a *fresh, independent
  connection pool* after the measured phase.
- Standard CI profile upper bound: 1–64 triggers. The opt-in scale profile allows up to **1,000 active definitions only with explicit `--events` of 1–64**, preventing accidental 1,000-event quadratic scans. Noise is capped at 64 events; replays are bounded by the number of matching events.
  Both profiles require explicit `EI_PG_PIPELINE_CONFIRM=YES_ISOLATED`.
  Tables are isolated with a random prefix and deleted even on failure.

The reported metrics are **monotonic-process-clock durations**:
`ingestToMatch` includes MCP normalization, validation/hash, trigger scan
and durable Pattern matching; `matchToWake` includes consumer and wake
coordinator processing, PostgreSQL durable claim/receipt and the local
fake host receipt; `ingestToWake` includes both. The p50/p95/p99
values are measured per **accepted matching event**, never fabricated.
A separate wall-clock throughput includes the 8/16 matching events only;
noise/replay and restart verification are explicitly excluded from the
timed interval. Individual events are ingested **serially**. There is
**no background provider transport or external model/agent execution**.

No production SLO is claimed from 8/16-event samples. The initial
regression gate requires deterministic correctness (100% persisted
receipts, zero duplicate host effects, zero noise wake), but does *not*
set a latency performance target until representative workloads and
production host/SLO budgets are agreed. This is a **smoke baseline**,
not a 100k high-cardinality throughput/capacity certification.

Run on a disposable PG database:

```sh
npm ci
npm install --no-save pg@8.16.3
npm run build
EI_PG_PIPELINE_CONFIRM=YES_ISOLATED POSTGRES_URL='postgresql://...' \
  node scripts/evidence/postgres-mcp-ingest-wake.mjs \
  --triggers 8 --noise 4 --replays 2 > pipeline-result.json
```

Raw artifacts include the completed or failed JSON record, the **actual
checked-out PR head SHA** (not merely GitHub's synthetic test merge SHA),
a GitHub test-merge SHA **only when triggered by a pull request** (null for manual dispatch), Node/Postgres versions, the
**exact pinned `pg@8.16.3` driver**, machine specifications and stderr.
Artifact names contain run ID **and run attempt** to permit actual reruns.
The chosen driver version is pinned at this benchmark workflow level;
the project's default npm manifest is not modified and transitive
dependency versions remain subject to the current npm installation graph.
Always compare hardware/PG/Node/driver information before drawing
cross-run performance conclusions. Failures in setup,
normalization, matching, delivery, independent-pool receipt re-read or
cleanup never report `status:completed`.

### Still missing before #47 acceptance

Workload-specific **1k/10k/100k active CEP** correlation profiles,
sustained and burst event rates, actual provider wire/polling delay,
remote host execution and confirmation, multi-tenant concurrent
partition churn, host crash after delivery before receipt, long-running
chaos/failover, full provider-to-wake latency distributions and
audited RPO/RTO and production SLOs. Existing 1k/10k/100k PostgreSQL
registration results must not be relabeled as active CEP capacity.


## Opt-in repeated occurrence / rate-controlled sampling (#47)

The existing 1k/10k/100k trigger-population experiments are **unchanged**.
For a SMALL (≤64-trigger) disposable profile, the new opt-in mode runs
many **different event IDs** against reused active triggers to collect
more real PostgreSQL ingest→match→wake latency samples.

```sh
EI_PG_PIPELINE_CONFIRM=YES_ISOLATED \
EI_PG_PIPELINE_REPEAT_CONFIRM=YES_ISOLATED_REPEAT \
POSTGRES_URL='postgresql://.../disposable_test_db' \
  node scripts/evidence/postgres-mcp-ingest-wake.mjs \
  --triggers 16 --events 1200 --sources 4 --noise 4 --replays 10 \
  --repeat-matches --rate 2 > repeated-pg-latencies.json
```

The monotonic clock paces at **no more than the requested events/s**;
slower database operations reduce achieved throughput rather than
silently making measured latency shorter. Every event is uniquely
identified, replay is exact source-ID replay, noise IDs cannot collide
with measured events, and a fresh independent PG pool checks **all**
durable receipts after reopen. Standard PG16 CI adds a low-cost 8
trigger/24 event opt-in smoke, including at least three rounds per
trigger and independent receipt verification.

Safety: explicit `EI_PG_PIPELINE_REPEAT_CONFIRM=YES_ISOLATED_REPEAT`;
≤64 triggers, ≤5000 matching events and rate 1–1000 events/s. Without
the explicit repeat flag, the original `--events <= --triggers` guard
still applies, as do the existing expensive large-population confirmation
requirements. No customer tables are used or migrated.

**Not a production SLO:** sequential single-worker ingestion, local
in-process host, missing provider wire time, and absent DB fault/partition
rebalance. A large sample count may produce a useful synthetic local
p99 but **cannot** satisfy the production SLO evidence contract or #47
until multi-worker, multi-rate, real-provider/host and fault evidence
are collected and independently reviewed.

## Per-event raw evidence and PostgreSQL service counters (#47)

The opt-in `--raw-evidence-out /path/to/new-file.json` flag writes a **separate
exclusive local artifact**, only after successful durable receipt verification
through an independently reopened PostgreSQL pool and successful cleanup.
The helper stages the complete raw JSON in a private `0600` file,
fsyncs the bytes, exclusively hard-links the final name, removes the staging
link and fsyncs its parent directory before reporting success. An existing
path fails closed and is never overwritten. The success JSON
includes SHA-256 of the **actual saved file bytes** (not a reserialized
JSON object), its sample count,
source commit and measurement scope. **Both jobs in `postgres-mcp-pipeline-evidence.yml`** now upload a\nsource-pinned raw artifact and independently recheck its per-event summaries\nbefore publishing success. The separate 1,200-sample workflow does the same;\nother active 1k/10k/100k benchmark workflows still publish their original\naggregate-only artifacts and are not implied to export raw per-event data.

Each occurrence has index, selected trigger slot, unique match/wake/receipt
identities, actual PostgreSQL candidate-definition count and measured
`ingestToMatchMs`, `matchToWakeMs`, `ingestToWakeMs` and
`hostCallbackMs`. The separate verifier also checks the raw measured wall-clock duration against the summary and recomputes actual achieved wake/event throughput (sample count divided by duration), rejecting inflated throughput figures even if the latency tails are untouched. It recomputes every p50/p95/p99/max
and checks stage conservation, uniqueness, candidate counts and matched
persisted receipts against the main JSON report. The producer must be inside a **clean actual Git checkout**: the
source SHA is verified against `git rev-parse HEAD`, any separately supplied
benchmark SHA, all tracked changes and untracked executable files under
`src/`, `scripts/` and `bin/` are rejected before measurement. Files with absent/null or
non-40-hex provenance cannot pass the verifier. Changing a percentile,
identity, host time or candidate count fails. The schema is
`event-intelligence.postgres-pipeline-raw-samples.v1`.

It also captures **before/after** PostgreSQL `pg_stat_database` counters:
transactions, block cache reads/hits, inserted/updated/deleted tuples,
temporary bytes and deadlocks; and actual isolated-prefix table bytes using
`pg_total_relation_size`. These counters are **database-wide**, not
EI-exclusive on a shared DB, and may lag the latest transaction due to
PostgreSQL asynchronous statistics reporting. The workload measures Node
process CPU/RSS separately. It does **not** measure PostgreSQL server
process CPU/RSS, per-query service time, host service CPU or provider
transport latency. A completed artifact must never be relabeled as
production SLO evidence.

These are still bounded **in-process synthetic provider / local host**
runs, usually only 8/16 events in CI. The production gate requires
independent ≥600-second steady, burst and fault campaigns with ≥1000
latency samples per stage, genuine provider transport and remote host
effect, multiple workers and partitions, PostgreSQL service resource
attribution, and pre-registered performance budgets. The new raw series
makes the available PG pipeline measurements independently auditable;
it does **not** satisfy those remaining #47 criteria by itself.

### Reproducible 1,200-sample PostgreSQL profile

`.github/workflows/postgres-pipeline-1200-raw-samples.yml`
now runs a separate real PG16 / Node 22 profile of **1,200 distinct**
MCP-shaped events across 16 reused active triggers and four synthetic
event names, under an upper-bound pacing rate of 20 events/second. It
verifies all 1,200 receipts on a reopened pool and checks replay/noise
do not produce extra host effects. The artifact records actual achieved
wall time, four latency distributions, raw per-event IDs and timings,
Node benchmark CPU/RSS, database-wide `pg_stat_database` counters and
five generated table sizes, hardware and exact checked-out Git SHA.

The job requires 1,200 real samples to pass an independent percentile
recalculation and rejects any failure to retain the file. **No SLO target
is silently inferred:** a rate *cap* is not a minimum throughput target,
and this job is generally shorter than 600 seconds, single-worker,
provider-in-process, callback-in-process and without injected failure.
It meets the raw-sample-count prerequisite for this bounded PG pipeline,
not the full production SLO evidence contract for #47.
