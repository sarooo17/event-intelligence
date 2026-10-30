# Host multi-tenant cold-start and scheduler diagnostic (#353)

This bounded test measures an existing risk: local EI host startup eagerly recreates a context, temporal deadline scheduler and wake-retry scheduler **for every persisted scope**, even if inactive.

Run after build:

    node scripts/validation/host-tenant-scope-scale.mjs --tiers=1,10,100 --samples=3

**Method:** each repeat seeds the disposable JSONL stores in a *different OS process* from the fresh measurement process. Startup wall time and RSS are measured only inside the fresh measured process, avoiding tier-dependent seeder cache in its baseline. During bootstrap and host shutdown, instrument actual global setInterval()/clearInterval() handle creation and destruction (including unref'ed intervals), and verify each scope's timer handle is observed and all created intervals are cleared after close. A separate GitHub Actions workflow uploads source-commit-pinned JSON artifacts. 1/10/1000 tiers are configurable but 1000 is not implicitly certified affordable.

This is an EI-maintained JSONL fixture, not a separately operated host, actual pending-wake restart recovery, PostgreSQL 16 shared-worker deployment, source-provider load, or production SLO. Three independently seeded measurements yield min/median/max, not a production p99. No claimed monthly cloud bill or developer-hour study.

**Finding under test:** existing local runtime uses O(persisted tenant scope count) scheduler contexts, not O(active scopes); 100 scopes means at least 200 scope interval handles per process. Do not implement lazy hydration until an alternative independently proves persisted pending deadlines, wake retries and orphan matches are still discovered and rebalanced after process failures.

**Acceptance:** partial #353 item 4 evidence only. Item 4 stays unchecked until actual shared-PG multiworker and timed recovery/scale behavior are also proven. No core API, dependencies, persistent schema or host controls changed.