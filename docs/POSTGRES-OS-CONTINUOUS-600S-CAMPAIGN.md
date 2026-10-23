# Continuous >=600s real independent-process PostgreSQL chaos (#47)

**Status: executable evidence campaign; NOT production SLO, full chaos/failover signoff or source/audit pruning authorization.** The campaign uses a disposable GitHub Actions PostgreSQL 16 service, **not Railway**, a fixture host ledger, and isolated process fixtures.

Prior #253 provides bounded worker crash/rebalance correctness tests; #259 provides a >=600s **single-worker** PG16 profile. This new workload targets continuously executed independent OS-process failures for at least 600 seconds of active cohort time.

## Run

The GitHub Actions workflow "PostgreSQL Independent OS Worker 600s Continuous Chaos" starts when its own runner/gate/test/workflow changes in a PR, or manually through workflow_dispatch. It pins exact HEAD, Node22, pg@8.16.3 and postgres:16-alpine. It refuses to run without an explicit disposable database, exact checkout SHA, and test-only confirmation.

Equivalent operator invocation against a **disposable** PG16 database:

~~~bash
EI_PG_CHAOS_SOAK_CONFIRM=YES_DISPOSABLE_PG \
SOAK_SOURCE_SHA="$(git rev-parse HEAD)" \
POSTGRES_URL='postgresql://disposable-user:password@127.0.0.1:5432/disposable-db' \
node scripts/evidence/postgres-os-600s-runner.mjs \
  --min-active-seconds 600 --cohorts 4 --rounds 10 \
  --max-batches 120 --out-dir pg-os-600s-raw
node scripts/evidence/postgres-os-600s-gate.mjs \
  pg-os-600s-raw "$(git rev-parse HEAD)"
~~~

The runner repeats real independent-worker PostgreSQL SIGKILL/recovery cohorts until the **sum of actual cohort wall times** reaches 600,000ms. Each cohort is a real OS process group with competing independent physical worker successors, durable PostgreSQL wake receipts and a fixture host-effect ledger. There are no synthetic sleeps to fill time. Every batch must succeed, otherwise no successful manifest is published.

All original batch-NNNN.json files are retained, with SHA-256 per batch in manifest.json, exact checkout SHA, PG16 server version, runner environment, measured active duration, complete per-round signals, killed/successor PIDs, match and wake identities, attempts, effects and receipts. A separate gate rereads **every** raw saved byte, validates each SHA-256, checks all independent OS process proofs and dedup, recomputes duration and rejects fake or missing evidence. Adversarial no-PG gate tests are included and are **not** themselves evidence of a completed 600s soak.

## Honest limits

This is genuine process SIGKILL fault injection and PostgreSQL 16 persistence/receipt proof on a disposable isolated CI host. It is NOT a remote MCP provider measurement, real external host effect, multi-zone/network partition, real DB service failover, high-cardinality mixed-rate benchmark, remote end-to-end SLO, immutable WORM copy or complete retention signoff. The manifest always states productionSloCertified=false. A completed green run is required before even asserting this **bounded** long-soak coverage. No rows or audit records are pruned and #47 stays open.
