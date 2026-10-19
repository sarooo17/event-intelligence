# PostgreSQL matched-wake definition lookup + per-operation profiling (#47)

## Observed bottleneck

The prior real active-trigger CI [run 39237414663](https://github.com/sarooo17/event-intelligence/actions/runs/39237414663)
showed a substantial **match-to-wake** interval at 10k/100k
definitions. Both `CompositeEventConsumer` and
`CompositeWakeCoordinator.deliverMatched` called
`store.listTriggers()` and filtered the **entire tenant definition
registry** for one `triggerId@version`, after the engine had already
matched an event. At 100k this caused two unnecessary tenant-wide
PostgreSQL JSONB fetches/parses **per fired match**.

This PR adds optional `store.getTrigger(triggerId, version)` and uses
it in those two wake paths. The PostgreSQL adapter reads one current
scope-local record by the existing
`(scope_id,kind,record_key)` primary index and validates the parsed
canonical trigger definition. No change to DB schema, source candidate
selection, producer replay identity, wake receipt, audit, host
permissions, or lifecycle authorizations. A remote tenant's trigger
with identical ID/version is not visible. No cross-event caching:
subsequent reads observe current durable records.

Adapters without `getTrigger` retain the existing `listTriggers()`
fallback. This is an additive optional interface only; no compatibility
shims or backdoor runtime-name dispatch.

## Measured evidence

`scripts/evidence/postgres-mcp-ingest-wake.mjs` now records a
`metrics.wakeStoreProfile` with call count, p50/p95/p99, max and
total **inclusive awaited wall** time for the actual PG store methods
invoked in the measured pipeline, including `getTrigger`,
`listTriggers`, receipt claim/complete, wake append and audit steps,
and `metrics.hostCallback`. The `definitionReadProfile` reports
indexed and full-registry reads for each measured event.

The method timings are diagnostic, not additive critical-path slices:
nested, concurrent or independently awaited calls may overlap. They
exclude registration, negative-event/replay verification, post-restart
receipt audit and cleanup. Baseline comparative timestamps from
separate CI jobs are subject to runner hardware/noise; do not infer
a causal speedup from two independent unpaired runs alone.

The PostgreSQL16 regression
`test/postgres-point-trigger-wake.test.mjs` disables full tenant
`listTriggers()` reads after registration, then exercises the real
consumer → engine → coordinator path across two trigger versions,
cross-scope isolation, receipts, exact replay without a second host
effect, and an intact verified audit chain.

The isolated full active 10k/100k matrix is explicitly re-run on this
PR by modifying its opt-in watched workflow comment; ordinary PRs do
not pay for that matrix. It produces separate raw outputs/artifacts
with exact commit, PostgreSQL16 and `pg@8.16.3`. See the PR check
itself for ACTUAL conclusions — checked-in harness code is not
proof it ran. Even green small samples do not validate sustained
multiworker CEP throughput, external host latency or production SLO.

**#47 remains open.** Continue with representative sustained rates,
tail-latency statistics, DB CPU/IO evidence, fault injection and
safe append-only retention before checking remaining acceptance boxes.
