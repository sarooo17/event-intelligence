# Active 1,000-trigger Pattern matching evidence — issue #47

This benchmark specifically addresses a different question from the earlier
100,000 **stored** trigger benchmark: *what happens when every incoming MCP
occurrence must be considered against a population of 1,000 active, eligible
Pattern v2 trigger definitions?*

## Selected workload (first bounded scale step)

The exact production `CompositeEventConsumer.ingestMcpOccurrence()` path
uses an actual isolated PostgreSQL 16 database and the production
`CompositeTriggerEngine`, `CompositeWakeCoordinator`, and durable receipt
store. A single fixture host returns an in-process receipt.

- **1,000** registered enabled trigger definitions, all subscribed to the
  same MCP event name with distinct `slot` predicate values. The engine
  enumerates every definition for every event; each enters the lifecycle and
  predicate checks. This is **1,000 eligible triggers, not 1,000 matches**.
- **16** matching MCP-shaped occurrences, selected at evenly spaced unique
  `slot` positions across the full 1,000-definition population. Exactly
  **16** matches, **16** durable wakes and **16** host receipt IDs are
  expected. The other 984 definitions remain unmatched yet eligible.
- **4** negative/noise occurrences that must not create matches or wakes.
  **2** repeated exact source occurrences that must reuse their original
  fired match/wake without a second host callback.
- All persisted receipts re-read after the first PostgreSQL connection pool
  is closed and a fresh physical pool reopens the same scope.
- Serial event ingress, concurrency=1; simple single-clause Pattern v2
  definitions, one source and one tenant. The workload does **not** use
  high-cardinality temporal correlations, semantics, derived events,
  multiple source network connections or actual host Turn execution.

The 1,000 definitions are *actively evaluated* for the 16 incoming events;
the first parameter (`--triggers`) is intentionally independent of the
second (`--events`). The default remains unchanged for the existing 8/16
small CI jobs, in which `events = triggers`.

### Reproduction

Workflow: `.github/workflows/postgres-active-1000-evidence.yml`,
which runs this profile only on PRs modifying this benchmark, its workflow,
or this document, plus explicit manual dispatch. It does not run on every
unrelated source PR. The existing small 8/16 job remains the inexpensive
measured-core correctness regression gate.

```sh
npm ci
npm install --no-save pg@8.16.3
npm run build
EI_PG_PIPELINE_CONFIRM=YES_ISOLATED POSTGRES_URL='postgresql://...' \
  node scripts/evidence/postgres-mcp-ingest-wake.mjs \
  --triggers 1000 --events 16 --noise 4 --replays 2 \
  > active-1000-result.json
```

The script uses a random, isolated PostgreSQL table prefix; a non-empty
explicit confirmation flag is required. It attempts to clean all tables even
if assertions fail; cleanup failures also fail the job. The job has a
35-minute limit and archives raw JSON, errors and environment diagnostics,
including pinned `pg@8.16.3`, Node/PG versions, reviewed commit and CI
attempt. A timeout/OOM is reported as a **failure**, never an invented
throughput result.

### Metrics and interpretation

The script measures actual serial in-process normalization→Pattern match,
match→durable wake and total accepted MCP event→wake p50/p95/p99;
matching-events/sec, CPU delta, RSS and exact-match/noise/replay correctness.
The measured interval **and sampled CPU/RSS end snapshot** exclude registration, negative events, replays,
database reopen/receipt audit and cleanup. CPU/RSS start samples are taken immediately after registration, and end samples immediately after the 16 matching events. All 16 events sample the same
registered population. No SLO thresholds are inferred before reviewing raw
runner measurements, and quantiles over 16 events are **small samples**.

This does **not** prove 1,000 simultaneously fired events, 1,000 matches,
100k high-cardinality active CEP scalability, sustained burst capacity,
multi-worker scaling, production provider→host end-to-end latency, no
external duplicates after an ambiguous host crash, or production-ready v1.
#47 remains OPEN for these separate acceptance requirements.

## CI issue discovered during first scale run

The first 1,000-trigger attempt ended with a **failed assertion** in the
benchmark itself: its final post-reopen host-effect count still compared
against registered trigger population (1,000), although only 16 events were
intentionally sampled. The logic is now corrected to compare against the
actual number of matching events; a failed first attempt is retained as an
artifact, **not** reported as a performance measurement. Later successes
must be justified by exact-HEAD CI artifacts, not inferred from this fix.
