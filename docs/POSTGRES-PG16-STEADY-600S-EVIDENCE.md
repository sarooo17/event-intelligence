# PostgreSQL 16 sustained 600-second steady pipeline baseline — #47

**Status: local/synthetic, single-worker, isolated persistent-store soak.
NOT measured external-provider/network/remote-host production SLO.**

The existing 1k/10k/100k actual PG16 reports exercise registration and
a small number of ingest→wake samples; the source-pinned 1,200-event raw
pipeline report (#255) gives more meaningful tails, but only runs for
approximately one minute. Neither alone proves repeated steady processing
for a full 600 seconds.

`.github/workflows/postgres-steady-600s-soak.yml` runs the same production
EI Pattern engine, composite consumer/wake coordinator and real isolated
PostgreSQL 16 using the existing opt-in benchmark:
- 16 continuously active trigger definitions across eight event names;
  **3,040 distinct durable MCP-shaped occurrence IDs** (each one should
  produce one match, wake, external-effect fixture receipt).
- Conservative monotonic start-rate **cap of 5 events/s**, not a throughput
  minimum. A delayed database operation can only slow the observed rate,
  never produce a burst intended to catch up.
- The start-to-finish interval must be **at least 600,000 milliseconds**;
  the ≥3,040 samples and independently re-opened authoritative PostgreSQL
  receipts must match. The raw artifact, host specifications, Git commit,
  Node process CPU/RSS, actual PostgreSQL database-wide counters and
  raw p50/p95/p99/max distributions are retained, including stderr for
  failures. Success requires exactly zero unaccounted duplicate host
  fixture calls, missing durable receipts or false wakes.
- `scripts/evidence/postgres-steady-soak-gate.mjs` independently verifies
  the literal saved-file SHA256, source commit, all per-occurrence stage
  timings, exact achieved throughput vs measured wall time, uniqueness
  of IDs, persisted receipt pairs and the actual ≥600s duration.
  It validates the PostgreSQL major version *reported by the server*
  before labeling an artifact PG16, and rejects any attempt to relabel
  this local experiment as production SLO.
- GitHub Actions 26-minute job cap and source-path opt-in avoid applying
  costly 600-second soaks to every normal PR. The production release gate
  should refer only to an actual successful exact-head run, never the
  existence of this workflow definition alone. Both benchmark stderr
  and strict-verifier failure JSON are retained separately in failed
  workflow artifacts to expose rejected duration, rate, checksum, server
  version and missing receipt claims.

### Non-claims

This is still **one Node.js worker**, a **synthetic provider in the same
process**, a **local counted host callback**, and the isolated PostgreSQL
service on the same GitHub runner. No true provider wire latency, host
response over the network, separate PostgreSQL service CPU/RSS, loss over
network partitions, remote DB failover, backlog response to multiworker
load or third-party retention evidence is measured. The data are useful
as a **sustained stability regression baseline**, not a substitute for
the #47's outstanding 600s+ steady/burst/fault multiworker and remote
provider/host measurement contract. No CI pass should tick the parent
production SLO acceptance or transferred #21 soak acceptance by itself.

### Reproduction

On an explicitly **disposable** PostgreSQL 16 instance, after
`npm ci`, installing pinned `pg@8.16.3` and `npm run build`, with
`POSTGRES_URL` pointing only to that disposable database:

```sh
EI_PG_PIPELINE_CONFIRM=YES_ISOLATED \
EI_PG_PIPELINE_REPEAT_CONFIRM=YES_ISOLATED_REPEAT \
BENCH_SOURCE_COMMIT="$(git rev-parse HEAD)" \
node scripts/evidence/postgres-mcp-ingest-wake.mjs \
  --triggers 16 --events 3040 --sources 8 \
  --noise 16 --replays 20 --repeat-matches --rate 5 \
  --raw-evidence-out pg-steady-raw-samples.json \
  > pg-steady-summary.json 2> pg-steady-errors.jsonl

node scripts/evidence/postgres-steady-soak-gate.mjs \
  pg-steady-summary.json pg-steady-raw-samples.json \
  "$(git rev-parse HEAD)"
```

The output should remain an independently verified record of what
actually happened. If the runtime cannot sustain 5/s, the measured rate
will be lower, and that shortfall must be reported rather than hidden.
