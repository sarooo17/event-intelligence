# PostgreSQL real-process OS kill chaos — operator evidence harness (#47)

This is a **manual, bounded and reproducible** extension of the merged
`test/postgres-os-sigkill-recovery.test.mjs` crash/lease-fencing regression.
The normal `npm run test:postgres` path still runs six rounds and does not
pay for a lengthy soak on every pull request.

## Reproduce

Invoke the manual GitHub Actions workflow
`PostgreSQL OS Kill Chaos (manual evidence)` and select 30, 60 or 120
rounds. It uses an isolated PostgreSQL 16 container and Node 22, then
retains the unredacted *synthetic fixture* process-kill log plus a JSON
report as a run artifact. It contains no application database DSN,
customer data or production credentials. Alternatively on an isolated
PG16 instance:

```bash
EI_CHAOS_ROUNDS=60 \
EI_CHAOS_EVIDENCE_OUT=/tmp/ei-pg-os-chaos-evidence.json \
POSTGRES_URL='postgresql://isolated_test_credentials@127.0.0.1:5432/ei_chaos' \
node --test test/postgres-os-sigkill-recovery.test.mjs
```

Build EI first with `npm run build` and install optional `pg` in the
test environment. `EI_CHAOS_ROUNDS` is validated as an integer 1..120;
invalid values fail closed. If not set it defaults to six.

Each round starts a **new, genuine child operating-system process**
and separate PostgreSQL pool, durably claims a wake and a partition
lease, then the parent uses actual `SIGKILL`. Recovery occurs using
a second process and another physical pool, with logical-time advance
to the exact lease expiry. Alternating rounds exercise restarted
workers using the same logical ID (ABA), and different worker IDs.
The parent verifies stale generation fencing, exact receipt
persisted once, inability to re-claim delivered wakes and partition
handover. A separate pool checks the durable receipts afterward.

When requested, the evidence file reports the configured round count,
confirmed kills, recovered receipt count, environment Node/OS/Postgres,
total run duration, p50/p95/p99 end-to-end **test round** time and
every round's elapsed handover duration, identities and stable receipt.
It is written only after successful assertions; the Actions log is
retained even on failure. If an un-reaped process makes cleanup unsafe,
the fixture preserves its isolated tables but closes the parent PG
pool instead of deleting data under a potentially live writer.

## What has not been proven

These are **synthetic lease/reclaim** fixtures, not real MCP provider
ingestion, complex pattern matching, a real external host callback,
database primary failover, a WAN/network partition or complete end-to-end
ingest-to-wake service. Logical-time expiry eliminates unnecessary
wall-clock waits; a 120-round successful run is repeated
process-crash evidence, **not 120 seconds of real lease expiry**.

The workflow is manually triggered to control GitHub Actions
expenditure. Publishing a workflow does not mean a 30/60/120-round
run has actually executed, and no SLO/RPO/RTO claims may be inferred.
Retain complete raw JSON and Actions logs with exact commit SHA and
compare multiple actual runs before considering #47 soak acceptance.

No producer integration, DB schema, regex, runtime scheduling,
Muffin/Artemis update or release change is included.
