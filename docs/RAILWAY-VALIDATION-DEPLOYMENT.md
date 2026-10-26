# Railway validation environment

This guide deploys the validation runtime in the `ei-validation` project and `staging` environment. The configuration is intended for the four services already requested: one PostgreSQL service and the three Node services. Confirm the actual PostgreSQL service name, project environment, and region in Railway before setting references; this repository does not inspect or change Railway state.

## Architecture and evidence boundary

`ei-worker-a` and `ei-worker-b` are separate Node processes with separate PostgreSQL pools and different `EI_WORKER_ID` values. They use the same `DATABASE_URL`, table prefix, and campaign scope. Each event enters `CompositeEventConsumer` and the real `CompositeTriggerEngine`; matches and wake delivery claims are persisted in `PostgresEventStore`. Wake delivery uses private HTTP to `ei-benchmark`, which records an idempotent host receipt keyed by `wake_id` and returns that receipt to EI.

`ei-benchmark` also generates MCP-shaped provider traffic and starts campaigns only after an authenticated request. It does not run a campaign on deploy. The provider and host endpoints are different HTTP routes, and worker traffic crosses Railway private networking, but provider and host share the same benchmark process and failure domain. The idempotency receipt table also lives in the shared PostgreSQL service, so this setup does not prove an independent host database or provider failure domain.

On worker startup, the validation service ensures a scoped expression index exists for trigger-match lookups. `listTriggerMatches(triggerId)` can then fetch just that trigger's records instead of loading every match in the campaign scope into Node.js for each event. The index is built with `CREATE INDEX CONCURRENTLY` on a dedicated connection with a 15-minute statement timeout; the normal 15-second request timeout is restored before that connection returns to the pool. A durable PostgreSQL metadata claim serializes the two workers' startup migration. Readiness waits for the verified index. An invalid/conflicting index or an interrupted migration fails closed and requires operator inspection; no match, history, receipt, or campaign rows are removed.

Measurements use monotonic time within `ei-benchmark` for provider request-to-worker-response, database-backed host callback duration, and provider-request-to-host-receipt end-to-end. The worker also returns `ingestToMatchMs` (elapsed time around the real trigger engine ingest/match call) and one `matchToWakeSamplesMs` duration per target match (from match completion through durable wake delivery result, including the private host callback). These worker-local spans use `performance.now()` and are aggregated without cross-container clock subtraction. Raw JSONL includes the per-event ingest-to-match value and includes match-to-wake only when exactly one target match was returned for that event; the report latency stream includes every target match. `providerToIngest` remains missing because the synchronous provider request currently receives its acknowledgement only after matching and delivery finish, so it cannot isolate the ingest acknowledgement boundary. The SLO gate remains `blocked`; the artifacts are evidence inputs, not a production certification. A single PostgreSQL service cannot test real database failover. This PR does not implement retention deletion or WORM storage.

## Create and link the three application services

In `ei-validation` → `staging`, add three services with **New → GitHub Repo**, choose `sarooo17/event-intelligence`, and select the same branch/commit for all three. Name the services exactly `ei-worker-a`, `ei-worker-b`, and `ei-benchmark`. In each service's Settings → Source, leave Root Directory at `/` (the repository root). Use the same commit/branch for all services.

Railway's legacy Config as Code gives file settings precedence over dashboard settings. This repository's root `railway.json` starts the existing JSONL service, so check each deployment's configuration source before using it. For a service already using Config as Code, set Settings → Config as Code → Config File Path to `/railway.validation-worker.json` on both workers and `/railway.validation-benchmark.json` on `ei-benchmark`. For a newly created service that does not use Config as Code, set the dashboard build/start/healthcheck commands below; Railway's current docs say new services cannot opt into legacy Config as Code. Verify the resolved commands on the deployment details page. Railway has deprecated Config as Code with a hard cutoff on 2026-12-01; these per-service JSON files support existing legacy services until then. See [Config as Code](https://docs.railway.com/config-as-code) and [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code).

These are the effective commands for both worker services:

```sh
npm ci --no-audit --no-fund && npm run build
npm run start:validation-worker
```

These are the effective commands for `ei-benchmark`:

```sh
npm ci --no-audit --no-fund && npm run build
npm run start:validation-benchmark
```

Use Node.js 22. The worker config path selects the PostgreSQL worker and the benchmark config path selects the campaign host. Workers use healthcheck `/readyz` with a 1,800-second deployment timeout to allow the online index migration and recovery scan to finish; the migration statement timeout is 900 seconds. The benchmark uses a 30-second timeout. All listen on Railway's injected `PORT` (defaulting to 3000 if run outside Railway), and restart on failure. Keep automatic sleep disabled and set one replica per worker and benchmark service. Set all four services to the same region. The supplied project context selected Amsterdam (EU West); verify that each service actually uses that region.

Do not generate public domains for the workers, benchmark, or PostgreSQL service. The worker admin, ingest, callback, and campaign endpoints are intended for the project/environment private network. Railway private DNS uses `<service-name>.railway.internal`; private HTTP traffic uses the service port. See [Railway private domains](https://docs.railway.com/networking/domains/working-with-domains) and [healthchecks](https://docs.railway.com/deployments/healthchecks).

## PostgreSQL service

Provision PostgreSQL 16 with a persistent volume. The benchmark database should be dedicated to this environment and have enough free storage for event, match, audit, wake and test receipt history. Keep the database private. Do not use `DATABASE_PUBLIC_URL`.

In the PostgreSQL service variables, no application-specific setting is needed. On each Node service, set `DATABASE_URL` using a Railway variable reference to the PostgreSQL service's private `DATABASE_URL`:

```text
${{Postgres.DATABASE_URL}}
```

Replace `Postgres` with the exact PostgreSQL service name shown in the project. Railway reference variables resolve within the same project and environment; they avoid copying credentials into service settings. See [Railway variable references](https://docs.railway.com/variables) and [private networking](https://docs.railway.com/networking/domains/working-with-domains).

The PostgreSQL service should use PostgreSQL 16, persistent storage, one replica, and a fixed resource limit during a measurement series. Do not change its size between comparable runs. Do not configure any worker to use a local JSONL store.

## Variables by service

Generate the three random tokens locally (for example, `openssl rand -hex 32`) and enter them as Railway variables. Never commit them or paste their values into issues or benchmark artifacts. References below use service names; adjust names only if the dashboard shows a different exact name.

### `ei-worker-a`

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `EI_SCOPE_ID` | `ei-validation` |
| `EI_TABLE_PREFIX` | `ei_validation` |
| `PORT` | `3000` (fixed private listener port) |
| `EI_WORKER_ID` | `ei-worker-a` |
| `EI_INGEST_TOKEN` | `${{ei-benchmark.EI_INGEST_TOKEN}}` |
| `EI_HOST_CALLBACK_TOKEN` | `${{ei-benchmark.EI_HOST_CALLBACK_TOKEN}}` |
| `EI_BENCHMARK_URL` | `http://${{ei-benchmark.RAILWAY_PRIVATE_DOMAIN}}:3000` |
| `EI_PG_POOL_MAX` | `10` |
| `EI_RECOVERY_MAX_SCOPES` | `1000` (optional; maximum scopes scanned on restart) |
| `EI_ENABLE_WORKER_CRASH_INJECTION` | `false` initially |

### `ei-worker-b`

Use the same values as worker A except:

| Variable | Value |
| --- | --- |
| `PORT` | `3000` (fixed private listener port) |
| `EI_WORKER_ID` | `ei-worker-b` |

Keep `EI_ENABLE_WORKER_CRASH_INJECTION=false` until the explicit fault-injection profile is approved for this staging environment. To enable it later, set it to `true` on both workers and set `EI_FAULT_TOKEN` on both workers to a new random token referenced from the benchmark service.

### `ei-benchmark`

| Variable | Value |
| --- | --- |
| `PORT` | `3000` (fixed private listener port) |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `EI_SCOPE_ID` | `ei-validation` |
| `EI_TABLE_PREFIX` | `ei_validation` |
| `EI_CONTROL_TOKEN` | random token, at least 32 characters |
| `EI_INGEST_TOKEN` | random token, at least 32 characters |
| `EI_HOST_CALLBACK_TOKEN` | a different random token, at least 32 characters |
| `EI_WORKER_A_URL` | `http://${{ei-worker-a.RAILWAY_PRIVATE_DOMAIN}}:3000` |
| `EI_WORKER_B_URL` | `http://${{ei-worker-b.RAILWAY_PRIVATE_DOMAIN}}:3000` |
| `EI_ARTIFACT_DIR` | `/data/artifacts` |
| `EI_ALLOW_100K` | `false` initially |
| `EI_WAKE_SETTLE_TIMEOUT_SECONDS` | `120` (optional, 1–900 seconds; maximum wait for durable retries and host receipts after traffic ends) |

Attach a Railway volume to `ei-benchmark` at `/data` to persist campaign artifacts. The volume adds storage, not a fifth service. For fault runs only, set `EI_FAULT_TOKEN` on benchmark to the same random token as the workers. The explicit campaign request also needs `faultConfirmation=CRASH_EI_WORKER_A`; this only terminates worker A and does not stop PostgreSQL.

### PostgreSQL service variables

No custom application variables are required on PostgreSQL. Railway supplies its database variables. The application services must reference that service's private `DATABASE_URL`; do not copy the connection string or password into GitHub.

## Fixed resources and region

Use the same region, replica counts and per-service CPU/memory limits throughout each comparison. These are starting allocations to measure and adjust after a smoke run, not SLO guarantees:

| Run | Each worker | `ei-benchmark` | PostgreSQL |
| --- | --- | --- | --- |
| Smoke / 1k triggers | 1 vCPU, 1–2 GiB | 1 vCPU, 2 GiB | 2 vCPU, 4 GiB, persistent volume |
| 10k triggers | 2 vCPU, 4 GiB | 2 vCPU, 4 GiB | 4 vCPU, 8–16 GiB, persistent volume |
| 100k triggers (explicit opt-in) | 4 vCPU, 8 GiB | 4 vCPU, 8 GiB | 8 vCPU, 32 GiB or higher, persistent volume sized for retained history |

Benchmark request limits are 1000 events/s, 32 in-flight HTTP requests, 3600 seconds, 250,000 events and 100,000 triggers. The 100k-trigger profile needs both `EI_ALLOW_100K=true` on the service and `EI_ALLOW_100K_RUN=true` in the operator shell; the CLI then sends `allow100k: true`. Expect index growth and additional setup time. Do not run it until the PostgreSQL storage and service limits are sized for the resulting retained records.

## Start and stop campaigns

Run these commands from the repository checkout with Node.js 22. If the workstation is outside Railway's private network, open a local port forward in one terminal (register an SSH key first, and copy the **service instance ID** for `ei-benchmark` from the Railway dashboard):

```sh
ssh -N -L 3000:ei-benchmark.railway.internal:3000 <service-instance-id>@ssh.railway.com
```

In another PowerShell window, point the CLI at the tunnel and read the control token without echoing it or putting it in command history:

```powershell
$env:EI_BENCHMARK_URL = 'http://127.0.0.1:3000'
$env:EI_VALIDATION_ALLOW_LOCAL_HTTP = 'true'
$secureToken = Read-Host 'EI_CONTROL_TOKEN' -AsSecureString
$env:EI_CONTROL_TOKEN = [System.Net.NetworkCredential]::new('', $secureToken).Password
```

The local HTTP exception is accepted only when `EI_VALIDATION_ALLOW_LOCAL_HTTP=true`; the deployed service configuration must keep its worker URLs on `.railway.internal`.

First smoke (10 triggers and 10 events; one worker per service, both workers used):

```sh
node scripts/validation/campaign-cli.mjs start smoke
```

The command returns a campaign ID. Check it and wait until `completed`:

```sh
node scripts/validation/campaign-cli.mjs status <campaign-id>
```

The smoke artifact must show events accepted by both worker IDs, verified wakes, a host receipt, an artifact checksum and `productionSloCertified: false`. This smoke checks the complete HTTP → PostgreSQL → CEP → private callback path; it does not meet the production SLO evidence thresholds.

To interrupt a long run safely:

```sh
node scripts/validation/campaign-cli.mjs stop <campaign-id>
```

Stopping prevents new provider events, waits for in-flight requests to settle, and writes the partial artifact. It does not delete campaign data. A stopped campaign is not SLO evidence.

After downloading and verifying all artifacts, a named campaign can be removed from EI and host receipt tables with an explicit operator command:

```sh
node scripts/validation/campaign-cli.mjs cleanup <campaign-id>
```

The service requires the campaign to be terminal, verifies the JSON and JSONL SHA-256 files and checks that both artifacts name that exact campaign scope. It then deletes rows only where `scope_id` equals the campaign UUID scope, in one transaction. The files stay on the Railway volume. No wildcard or all-scopes cleanup route exists.

### 1k / 10k / 100k plan

For setup or functional verification, use `profile=smoke` with `triggerCount` set to 1,000 or 10,000 and a bounded event count. For SLO comparison, each of `steady`, `burst`, and `fault-injected` must run for at least 600 seconds, have at least two actual workers, two or more partitions, 1,000 verified wakes, and 1,000 valid samples for every required latency series. The runtime now reports worker-local monotonic `ingestToMatch` and `matchToWake` spans. `providerToIngest` is still missing because no separate ingest acknowledgement boundary exists; the gate therefore remains blocked pending that measurement and the other stated SLO prerequisites.

The CLI defaults `smoke` to 10 triggers and 10 events. To smoke-test a larger persistent trigger set while keeping event load small, set both values explicitly; `EI_TRIGGER_COUNT` also works for `steady`, `burst`, and `fault-injected`:

```powershell
$env:EI_TRIGGER_COUNT = '10000'
$env:EI_EVENT_COUNT = '20'
node scripts/validation/campaign-cli.mjs start smoke
```

Use `steady` at a constant rate, `burst` with a higher rate and concurrency (up to 32), and `fault-injected` only after setting the opt-in fault token and operator confirmation. The fault profile terminates worker A and routes subsequent work to worker B; it exercises worker recovery and request routing. Database interruption is refused in this single-PostgreSQL deployment. PostgreSQL failover requires a separate HA environment and an explicitly approved fault procedure. No service will kill or terminate the database from the campaign API.

Example PowerShell runs (after the private tunnel and control token are set):

```powershell
# 1k persistent triggers, 600 seconds, 10 events/s
$env:EI_TRIGGER_COUNT = '1000'
$env:EI_EVENT_COUNT = '6000'
$env:EI_REQUESTED_RATE = '10'
$env:EI_DURATION_SECONDS = '600'
$env:EI_CONCURRENCY = '1'
$env:EI_PARTITIONS = '2'
node scripts/validation/campaign-cli.mjs start steady

# Repeat with 10k persistent triggers
$env:EI_TRIGGER_COUNT = '10000'
node scripts/validation/campaign-cli.mjs start steady

# 100k persistent triggers; requires EI_ALLOW_100K=true on ei-benchmark too
$env:EI_TRIGGER_COUNT = '100000'
$env:EI_ALLOW_100K_RUN = 'true'
node scripts/validation/campaign-cli.mjs start steady

# Burst example: five-second groups, 20 events/s, up to 8 in-flight requests
$env:EI_TRIGGER_COUNT = '1000'
$env:EI_EVENT_COUNT = '12000'
$env:EI_REQUESTED_RATE = '20'
$env:EI_CONCURRENCY = '8'
node scripts/validation/campaign-cli.mjs start burst
```

For the fault profile, also set `$env:EI_FAULT_CONFIRMATION = 'CRASH_EI_WORKER_A'`, enable `EI_ENABLE_WORKER_CRASH_INJECTION=true` on the workers, and configure the separate random `EI_FAULT_TOKEN` on the benchmark and workers. This profile requires a fresh 600-second run and explicit authorization; it does not represent a database failover test.

## Evidence export and integrity checks

Each run writes JSON metrics, bounded JSONL monotonic latency samples, and SHA-256 checksum files under `/data/artifacts`. Artifacts are partial measurements, not proof of retention or a certified SLO. Download a specific file from the mounted volume with Railway's volume file command, or use the dashboard volume browser; for example:

Railway's volume CLI requires selecting the volume by its dashboard ID or name; use the volume attached to `ei-benchmark`:

```sh
railway volume files --volume <volume-id> download /artifacts/ei-validation-<campaign-id>.jsonl ./ei-validation-<campaign-id>.jsonl --environment staging
railway volume files --volume <volume-id> download /artifacts/ei-validation-<campaign-id>.jsonl.sha256 ./ei-validation-<campaign-id>.jsonl.sha256 --environment staging
```

Then verify JSON and raw sample/checksum integrity:

```sh
node scripts/validation/campaign-cli.mjs verify-artifact ./ei-validation-<campaign-id>.json
```

The verifier rejects checksum mismatches, unknown schemas, self-certification, or an artifact that fails to declare its missing metrics. Review raw events and sample counts against the JSON summary before using the data externally. Railway supports volume browsing and file download through its CLI; see [Railway volume files](https://docs.railway.com/cli/volume).

## Return to the initial state

Stop any active campaign first. Download and verify all needed artifacts, then use the explicit campaign cleanup command for each disposable campaign. Do not truncate PostgreSQL tables or delete the shared EI prefix. Campaign rows are isolated under `EI_SCOPE_ID:<campaign-uuid>`; cleanup retains the exported files on the Railway volume. To stop compute, stop the deployments in the Railway dashboard; retain PostgreSQL and artifact volumes until evidence is no longer needed. Removing either volume destroys benchmark evidence.
