# E48-B — strict full TriggerInspector.inspect() under real PostgreSQL 16 and remote host effects

**Acceptance state: UNPROVEN until Railway raw results are independently inspected.** This is a repeatable E48-B candidate workload and evidence collector, not production SLO certification.

## Procedure

The one-shot Railway service runs `scripts/validation/live-e48b-inspector-once.mjs`. It requires a private dedicated volume for results (`EI_E48B_ARTIFACT_DIR=/evidence`) and a new isolated PostgreSQL table prefix, `EI_E48B_TABLE_PREFIX=ei_e48b_profile`. The runner validates the prefix and never modifies existing EI worker tables except by **normal authenticated host API traffic**.

`DATABASE_URL` references the same PostgreSQL 16 service as the worker services, so host traffic and Inspector queries share real PG physical resources. The worker A/B URLs, host ingest token and validation host scope are Railway private references. No OpenAI or other paid LLM calls.

For each population **1,000 / 10,000 / 100,000 actual persisted trigger-match candidates** in a fresh isolated scope, the runner:

1. Inserts actual JSONB candidates through PostgreSQL `generate_series` into a keyed `trigger_match` collection. Validates the exact persisted count; no in-memory-only mock candidates.
2. Performs warmup followed by **150 or more** actual full `TriggerInspector.inspect({triggerId,version,matchId})` calls using strict inspection limits (8/8/8) and the oldest, midpoint, newest and two other real candidate IDs. Saves every raw latency and refusal outcome with CPU user/system microseconds, Node heap and RSS peak, p50/p95/p99 and the exact run count.
3. Repeats full inspector under **actual concurrent network load to independent Railway EI workers**: authenticated `/v1/triggers/batch` and `/v1/events` with non-sensitive fixture events, real callback to the separately deployed benchmark host, and verification of distinct host wake/receipt rows in PostgreSQL. Both worker IDs must be observed and counts must reconcile.
4. Takes **actual per-isolated-PG-table** `pg_statio_user_tables` heap and index cache-hit/read counter snapshots surrounding the inspector measurements, plus a real `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for a representative exact-key strict Inspector query. These cumulative asynchronous stats are **not** an invented per-transaction physical I/O measurement. The EXPLAIN reports statement-buffer use for the selected exact-key read; do not infer it measures all SQL issued by `inspect()`.
5. Verifies broad latest-candidate selection refuses above the bounded `maxCandidates` window, while exact keyed full Inspector calls remain eligible. All failures and timeouts remain in raw samples, never omitted to improve p99.
6. Creates **real PG backend pool contention** by running `SELECT pg_sleep(0.55)` on a dedicated single-connection test pool, verifies full Inspector pool wait fails and recovers after release. Attempts `pg_terminate_backend` **only** on that isolated test connection and checks clean recovery; if lacking rights reports it as not tested, never claims it happened.
7. fsyncs raw stage JSON and final manifest to an off-runner persistent private volume. The console output has only counts, p99, hashes and statuses, **no raw candidate data, tokens or database URLs**.

## Inputs and interpretation

- `EI_E48B_SAMPLES`: each phase has 100–1500 calls (default 150, for 900 measurement samples across 3 populations x baseline/loaded).
- `EI_E48B_HOST_EVENTS`: total event quota 10–2000 (default 150, allocated across the three loaded phases).
- Source exact main SHA is pinned in `EI_E48B_SOURCE_SHA`.
- `EI_E48B_TABLE_PREFIX` **must start `ei_e48b_`** to prevent accidental writes to unrelated tables.
- `EI_E48B_HOST_SCOPE_BASE` must be a validation namespace authorized by the worker/benchmark host. Raw workload scope contains a run UUID; no customer tenant is used.

The runner retains the **dedicated test PG tables** rather than pruning them automatically, for independent SQL replay and investigation. Any subsequent cleanup requires an explicit operator-only operation and confirmation that the archived evidence is adequate. This incurs PostgreSQL storage cost, particularly at 100,000 rows.

### What does NOT count as E48-B evidence

Synthetic `measureRailwayInspector` results with only 25 calls are not enough. `EXPLAIN` alone is not full-inspector end-to-end latency. Cumulative PG I/O counters are not automatically per-Inspector CPU or storage throughput; process CPU/RSS include the host traffic generator and must be labeled as process-wide. A locally simulated database rejection is not a real PG backend failure. The host-load workload must include validated **actual host effect receipts**, not just HTTP /health requests.

The #376 E48-B checkbox remains unchecked until the independently inspected 1k/10k/100k live campaigns, failure/refusal results and raw artifact manifest are available and review gates pass.
