# Reproducible PostgreSQL SIGKILL recovery soak (#47)

## Evidence type

An operator-triggered repeat of the **existing real PG16 worker-process**
`test/postgres-os-matched-contenders.test.mjs`, rather than a simulated
in-memory crash or an inference from microbenchmarks. Each cohort creates
a fresh uniquely named disposable set of PostgreSQL tables. In every
round an OS child process is terminated after persisting a logical MCP
Pattern match and independent competitor processes contend for its
durable wake. The harness verifies the complete original test's contract,
including committed unique matches, persisted host receipts and zero
duplicate attempts against a fixture host ledger.

`scripts/evidence/postgres-os-chaos-soak.mjs` invokes N independent
cohorts sequentially and returns **no success artifact at all** if any
child exits abnormally, a test assertion fails, the evidence JSON is
missing/malformed, or isolated PG cleanup fails. It validates every
cohort against its declared round count rather than allowing missing
cohorts to reduce the denominator. Raw per-round evidence, host
attempt/effect accounting, hardware, Node version and actual checkout
source SHA are preserved.

## Execute

Use Actions → **PostgreSQL OS Crash-Recovery Soak Evidence** → Run workflow
on a trusted branch. Choose 4/8/12 cohorts with 10/20/30 SIGKILL rounds
each. On PRs changing the runner/workflow, a small **1-cohort, 3-round**
real-PG16 smoke runs automatically. The manual default is 8 × 30 = 240
independent OS worker crash/recovery rounds on PostgreSQL 16.

The workflow pins checkout to `pull_request.head.sha` or manual run's
`github.sha`, uses a read-only token, a disposable PostgreSQL 16 service,
real SIGKILL processes, a per-cohort upper time limit, and produces the
immutable `postgres-os-chaos-soak-<run-id>` JSON artifact on success.

Local, against a **disposable PostgreSQL database only**:

```sh
EI_PG_CHAOS_SOAK_CONFIRM=YES_DISPOSABLE_PG \
POSTGRES_URL='postgresql://.../disposable_db' \
node scripts/evidence/postgres-os-chaos-soak.mjs \
  --cohorts 4 --rounds 30 --max-cohort-minutes 15 \
  --out os-chaos-soak-result.json
```

Do not use customer tables or production credentials. A timeout or
process interruption may leave isolated tables requiring **explicit
operator cleanup** inside that disposable database; never interpret
partial JSON or a cancelled Actions run as passing evidence. A
successful run is guaranteed to have fully cleaned up its own tables
by the child regression, before emitting its summary artifact.

## Correct interpretation and remaining gaps

This exercises **one** important crash boundary under repeated
independent OS restarts, PG contention and host receipt durability. It
does **NOT** simulate actual provider network delivery or cursor
acknowledgment, a split-brain/partitioned database, physical Postgres
failover, real external host side effects, remote resource saturation,
or load at 10k/100k triggers. The simulated MCP occurrence and durable
host-effect fixture ledger must be distinguished from remote integration.

This raw evidence can help finish the #47 multiworker chaos acceptance
**only in combination with** the other independent-provider replay,
actual DB unavailability/partition tests and long sustained rates.
Likewise no production SLO is certified by zero duplicate effects in
one isolated test configuration. Public 1k/10k/100k results and true
production SLO signoff remain distinct criteria.
