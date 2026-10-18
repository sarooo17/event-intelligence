# Real PostgreSQL MCP occurrence → match → wake evidence (#47)

This new benchmark measures the actual `CompositeEventConsumer.ingestMcpOccurrence()`
pipeline against an isolated PostgreSQL 16 database:

`MCP-shaped occurrence (in memory) → safe normalization/hash → canonical
Pattern v2 engine → durable matched state → durable wake claim → EI wake
→ host-controlled callback receipt → durable fired/receipt state`.

It is **not** the previous 1k/10k/100k registration benchmark, or the
synthetic in-memory Pattern evaluator benchmark. The definition and match
processing execute in production EI code with real PostgreSQL IO.

## Workload and invariants

The benchmark CI jobs also trigger on production implementation changes
to Pattern v2, MCP event conversion, the composite consumer/wake
coordinator, and PostgreSQL storage. They are therefore a **small
correctness-regression gate** for changed measured code, not just a
manually requested report. This adds bounded CI cost (two isolated
PostgreSQL 16 jobs) to relevant source PRs; it still does not certify
production throughput or full host effects.

The GitHub Actions workflow
`.github/workflows/postgres-mcp-pipeline-evidence.yml` performs **two
separate isolated jobs**, currently 8 and 16 active durable triggers,
respectively. In each job:
- Every trigger watches the same event source/name, distinguished by a
  deterministic, valid `slot` predicate; matching input must fire exactly
  one logical match and one unique wake/host receipt.
- 4 unmatched events must have zero logical matches and wake effects.
- 2 exact source-event replays must be deduplicated: no second host effect.
- The callback is an in-process **fake host** that returns a stable receipt;
  the persisted PostgreSQL status is verified through a *fresh, independent
  connection pool* after the measured phase.
- Standard CI profile upper bound: 1–64 triggers. The opt-in scale profile allows up to **1,000 active definitions only with explicit `--events` of 1–64**, preventing accidental 1,000-event quadratic scans. Noise is capped at 64 events and replays at 1–N
  replays, configured only with explicit `EI_PG_PIPELINE_CONFIRM=YES_ISOLATED`.
  Tables are isolated with a random prefix and deleted even on failure.

The reported metrics are **monotonic-process-clock durations**:
`ingestToMatch` includes MCP normalization, validation/hash, trigger scan
and durable Pattern matching; `matchToWake` includes consumer and wake
coordinator processing, PostgreSQL durable claim/receipt and the local
fake host receipt; `ingestToWake` includes both. The p50/p95/p99
values are measured per **accepted matching event**, never fabricated.
A separate wall-clock throughput includes the 8/16 matching events only;
noise/replay and restart verification are explicitly excluded from the
timed interval. Individual events are ingested **serially**. There is
**no background provider transport or external model/agent execution**.

No production SLO is claimed from 8/16-event samples. The initial
regression gate requires deterministic correctness (100% persisted
receipts, zero duplicate host effects, zero noise wake), but does *not*
set a latency performance target until representative workloads and
production host/SLO budgets are agreed. This is a **smoke baseline**,
not a 100k high-cardinality throughput/capacity certification.

Run on a disposable PG database:

```sh
npm ci
npm install --no-save pg@8.16.3
npm run build
EI_PG_PIPELINE_CONFIRM=YES_ISOLATED POSTGRES_URL='postgresql://...' \
  node scripts/evidence/postgres-mcp-ingest-wake.mjs \
  --triggers 8 --noise 4 --replays 2 > pipeline-result.json
```

Raw artifacts include the completed or failed JSON record, the **actual
checked-out PR head SHA** (not merely GitHub's synthetic test merge SHA),
a GitHub test-merge SHA **only when triggered by a pull request** (null for manual dispatch), Node/Postgres versions, the
**exact pinned `pg@8.16.3` driver**, machine specifications and stderr.
Artifact names contain run ID **and run attempt** to permit actual reruns.
The chosen driver version is pinned at this benchmark workflow level;
the project's default npm manifest is not modified and transitive
dependency versions remain subject to the current npm installation graph.
Always compare hardware/PG/Node/driver information before drawing
cross-run performance conclusions. Failures in setup,
normalization, matching, delivery, independent-pool receipt re-read or
cleanup never report `status:completed`.

### Still missing before #47 acceptance

Workload-specific **1k/10k/100k active CEP** correlation profiles,
sustained and burst event rates, actual provider wire/polling delay,
remote host execution and confirmation, multi-tenant concurrent
partition churn, host crash after delivery before receipt, long-running
chaos/failover, full provider-to-wake latency distributions and
audited RPO/RTO and production SLOs. Existing 1k/10k/100k PostgreSQL
registration results must not be relabeled as active CEP capacity.
