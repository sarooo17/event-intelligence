# Active 10k/100k MCP ingest-to-wake evidence (issue #47)

This is **not** the 1k/10k/100k durable *registration* benchmark,
nor an in-memory Pattern microbenchmark. It runs the real
`CompositeEventConsumer.ingestMcpOccurrence()` → Pattern v2
`CompositeTriggerEngine` → PostgreSQL authoritative match/wake
→ `CompositeWakeCoordinator` → **local fixture host receipt** pipeline,
on isolated PostgreSQL 16. The host callback is not a remote agent.

## Explicit high-volume guard

The existing `postgres-mcp-ingest-wake.mjs` harness may now
accept at most 100,000 active registered definitions, but any
population larger than 1,000 **must** be explicitly approved with
`EI_PG_PIPELINE_LARGE_CONFIRM=YES_ISOLATED_LARGE` in addition to the
existing `EI_PG_PIPELINE_CONFIRM=YES_ISOLATED`.
Above 1,000, an explicitly provided `--events` of at most 16 is
mandatory. There is no risk of a default 100k-by-100k cross product.
Existing ≤1k behavior and the small CI smoke remain unchanged.

A heavyweight GitHub Actions workflow runs **only** on PRs changing
`.github/workflows/postgres-active-large-evidence.yml` or on explicit
manual dispatch, never on normal feature PRs. Each run uses a fresh
Postgres service, Node 22, exact `pg@8.16.3`, 90-min timeout per profile,
recorded exact source commit, raw result/errors and environment artifacts.
Profiles are independent (a failure does not cancel the other two):

| Profile | Registered active definitions | Event names | Sampled matching events |
| --- | ---: | ---: | ---: |
| 10k-sources1 | 10,000 | 1 | 8 |
| 100k-sources1 | 100,000 | 1 | 2 |
| 100k-sources20 | 100,000 | 20 | 2 |

Two noise occurrences and one forced exact replay verify zero false wakes
and no additional host callback per profile. Receipt identity/attempt
generation is rechecked from a completely new PostgreSQL pool. Source
candidates, ingest-to-match/match-to-wake/ingest-to-wake p50/p95/p99,
Node-only CPU/RSS and sample throughput are recorded in raw JSON.

**Interpretation:** registered trigger count differs from per-event
eligible candidate count when 20 distinct event names split the
population. In the 1-event-name case, every incoming sample has
100,000 eligible definitions. There are only **two** sampled 100k events,
so p95/p99 are mathematically reported but statistically uninformative
as a production latency objective. High-cardinality temporal correlation,
multiple concurrent workers, burst/backlog behavior, provider wire
transport, external host latency, source outages and network partition
remain **unproven**.

## Acceptance boundary

A successful full high-scale matrix is useful capacity/correctness
**evidence** but does not complete #47's benchmark or SLO acceptance
on its own. Real representative rates, more samples/partition
distributions, sustained workload, error budget, host idempotency, DB
resource usage and measured recovery under faults still need evidence.
Failures, including OOM/timeouts, are recorded, not silently recast
as success. Large profiles must run only in disposable databases, never
against customer data. No EI production API/schema, runtime-specific
integration, regex refactor or npm release is changed.
