# Host multi-tenant cold-start and scheduler diagnostic (#353)

This bounded test measures an existing risk: local EI host startup eagerly recreates a context, temporal deadline scheduler and wake-retry scheduler **for every persisted scope**, even if inactive.

Run after build:

    node scripts/validation/host-tenant-scope-scale.mjs --tiers=1,10,100 --samples=3

**Method:** each repeat seeds the disposable JSONL stores in a *different OS process* from the fresh measurement process. Startup wall time and RSS are measured only inside the fresh measured process, avoiding tier-dependent seeder cache in its baseline. During bootstrap and host shutdown, instrument actual global setInterval()/clearInterval() handle creation and destruction (including unref'ed intervals), and verify each scope's timer handle is observed and all created intervals are cleared after close. A separate GitHub Actions workflow uploads source-commit-pinned JSON artifacts. 1/10/1000 tiers are configurable but 1000 is not implicitly certified affordable.

This is an EI-maintained JSONL fixture, not a separately operated host, actual pending-wake restart recovery, PostgreSQL 16 shared-worker deployment, source-provider load, or production SLO. Three independently seeded measurements yield min/median/max, not a production p99. No claimed monthly cloud bill or developer-hour study.

**Finding under test:** existing local runtime uses O(persisted tenant scope count) scheduler contexts, not O(active scopes); 100 scopes means at least 200 scope interval handles per process. Do not implement lazy hydration until an alternative independently proves persisted pending deadlines, wake retries and orphan matches are still discovered and rebalanced after process failures.

**Acceptance:** partial #353 item 4 evidence only. Item 4 stays unchecked until actual shared-PG multiworker and timed recovery/scale behavior are also proven. No core API, dependencies, persistent schema or host controls changed.

## R4 1/10/100/1000 tier expansion (2026-10-30)

The existing scoped host already instruments **real** `setInterval` and
`clearInterval`, including unref'ed handles, in separate *fresh* OS
processes. The scoped-state workflow now explicitly executes
`--tiers=1000 --samples=1` in addition to three replicates per 1/10/100
tier and fails if a process, timer, or scheduler cleanup invariant is broken.
The `host-scope-all-tiers-summary.json` artifact captures cold start,
RSS delta, number of real timer intervals and shutdown cleanup for every
tier, pinning to its executing Git commit. A sampled 1000-tenant measurement
is **not** a 1000-tenant load test, operational acceptance threshold,
or evidence of bounded per-active-scope timer work; 1000 is deliberately
sampled once due to cost and CI budget.

**Existing architecture has one temporal scheduler and one wake-retry
scheduler per persisted scope**, rehydrated during startup whether active
or not. A simple lazy-on-demand store hydration would silently miss pending
wake/deadline recovery from inactive scopes; no such unsafe shortcut is
introduced by this measurement.

Existing independent PostgreSQL16 two-process/outbox/revocation/recovery
fixtures in reviewed [#361](https://github.com/sarooo17/event-intelligence/pull/361)
demonstrate a different boundary from these local JSONL measurements.
They do **not** establish 1/10/100/1000 scoped-PG workloads, real external
providers, network partition behavior or full production tenant scaling.
Those remain separate from R4's bounded reference-scale evidence and
operator/security release gates #47/#317. Do not mark them passed from
timer counts or synthetic activation envelopes.
