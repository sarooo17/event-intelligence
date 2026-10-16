# Bounded trigger explanation (first implementation slice)

Tracking [#48](https://github.com/sarooo17/event-intelligence/issues/48).

`TriggerInspector.inspect()` already exposes pattern, lineage refs, status and event-time deadlines. This slice adds machine-readable **observed/waiting clause progress** and bounds the *serialized* match history.

## Output

The inspector now returns:

```json
{
  "evidenceSummary": {
    "selectionBasis": "latest_match",
    "observedClauseIds": ["merged"],
    "unobservedClauseIds": ["deployed"],
    "pendingDeadlineCount": 1,
    "nextEvaluationAt": "2026-10-01T12:30:00.000Z"
  },
  "lineage": {
    "matchHistory": [],
    "historyTruncated": true,
    "historyLimit": 100
  }
}
```

The example is illustrative. `observedClauseIds` and `unobservedClauseIds` only describe evidence attached to the selected match—not whether an `anyOf`, absence or optional branch still needs more events. **They do not assert the Pattern AST is unsatisfied or that missing events never happened externally.** `selectionBasis` is `explicit_match`, `latest_match`, or `no_match`, reflecting how the inspection target was actually selected. Pending deadlines come from the scoped store.

**History is complete by default**, preserving the existing inspection response contract. Host operators may opt into a bounded recent window by configuring `matchHistoryLimit` as an integer from 1–500; invalid values throw. When opted in, `historyTruncated` states whether the result omitted older records and `historyLimit` reports the cap. An implicit/default truncation would be a breaking and potentially misleading change and is deliberately avoided. Full history remains accessible only through an authorized store.

**Storage read cost:** With an explicit `matchHistoryLimit`, the inspector prefers the optional `getRecentTriggerMatchHistory(matchId, { limit })` store capability, which can use an indexed bounded query (PostgreSQL implementation tracked in [#60](https://github.com/sarooo17/event-intelligence/pull/60)). A custom store without that method falls back to reading its full history and slicing the response. The default unbounded inspection continues to request full history. This is capability negotiation, not a legacy host adapter. Retention and full cursor pagination remain [#47](https://github.com/sarooo17/event-intelligence/issues/47).

No raw source-event payload is added to these fields, and no model is involved in producing explanations. The host remains responsible for restricting inspection to authorized owners/tenants.

## Test

```bash
npm run build
node --test test/trigger-explain-bounds.test.mjs
```

Remaining #48 work: versioned explain contract; unavailability/watermark/truncation distinctions; bounded store queries; causal trace correlation; redaction validation and optional OTel bridge.

## Optional OpenTelemetry bridge (partial #48)

A host with its own OTel SDK can inject a tracer into the EI observability sink,
with no OTel dependency added to EI or host credential management moved into EI:

```js
import {
  createOpenTelemetrySink,
} from 'mcp-event-intelligence/observability';
import {
  createEventIntelligence,
} from 'mcp-event-intelligence/embedded';

// hostRuntime, hostStore and hostOwnedTracer are supplied by the embedding host.
const otelSink = createOpenTelemetrySink(hostOwnedTracer);
const integration = await createEventIntelligence({
  runtime: hostRuntime, observability: otelSink, store: hostStore,
});
```

The bridge emits one completed span for each sanitized `ei.*` telemetry
record. By default, **only** event name, schema, level, component, status and
attempt count are included; no raw payload, error message, metadata, tenant or
trace/wake ID is forwarded. `includeCorrelations: true` optionally adds
length-bounded/redacted trace, scope, trigger, match and wake identifiers for
hosts that have approved the privacy, cardinality and retention implications.
The adapter re-sanitizes even direct uses, and failures in the host tracer
are swallowed so matching/delivery cannot depend on telemetry.

**Limits:** This is a minimal span sink, not full distributed propagation:
it does not establish parent-child causal context, automatic span duration,
external metrics, sampling or traces across an embedding runtime. Hosts own
the OTel exporter, SDK, authentication and sampling. Those and other
explainability acceptance tests remain part of #48.


## Verified PostgreSQL read/restart boundary (bounded regression, v1 preparation)

`test/postgres-inspector-restart.test.mjs` uses two **real independent PG16
connection pools** and two tenant scopes with the *same* trigger ID, version
and match ID. It appends multiple revisions of a partially observed trigger,
then verifies:

- Owner-scoped `TriggerControlPlane`/MCP read guard authorizes the
  configured owner and refuses a foreign principal *in the same queried
  scope*, before exposing an inspection. The bare `TriggerInspector` is a
  low-level trusted-store API; **it does not supply user authorization**.
- With an explicit bounded history limit, each tenant sees only its own
  2/3 latest revisions and accurate `historyTruncated`, evidence refs and
  factual observed/waiting clauses; raw event `data` stays out of outputs.
- The first worker pool is completely closed, another independent pool
  opens the same persisted tenant scope and reinitializes the Postgres store,
  and the full ref-only inspector result is **deep-equal** across restart.
  The second tenant's colliding logical IDs remain isolated.

Run `POSTGRES_URL=... npm run test:postgres`; without a configured
PostgreSQL connection this integration test skips. This covers bounded
restart and owner guard evidence, **not** runtime-wide authorization,
network failover, actual OS process kill, a total causal graph, or every
explanation status code. Do not mark all of #48 as production-ready based on
this single scenario.


## Versioned machine-readable diagnosis (new #48 slice)

`TriggerInspector.inspect()` now additionally returns a small
`diagnosis` object: `contract:"ei.trigger-inspection.v1"`,
`kind`, `evidence:"persisted_state"`,
`sourceCertainty:"unverified"`, `missingClauseIds` and
`pendingDeadlineCount`. This is **additive**; existing `why.code`,
`evidenceSummary`, and host-owned owner/scope authorization do not
change. Kinds are `no_local_match`, `pattern_pending`,
`temporal_pending`, `effect_pending`, `wake_failed`,
`fired`, `derived_emitted`, `condition_satisfied`, `match_expired`,
`inactive` and `lifecycle_ended`.

The classification uses only previously read persisted state: the
trigger lifecycle, selected match, deadline list and wake status.
`wake_failed` requires a real `dead_letter` wake; when no wake
is present the reason is only `effect_pending`, never a fabricated
delivery failure. `temporal_pending` requires a stored pending
deadline. `missingClauseIds` reports refs not present on the
**selected** match only, not a proof that an arbitrary Pattern AST
branch is unsatisfiable.

All statuses retain `sourceCertainty:"unverified"`, explicitly
preventing a diagnosis from claiming provider delivery completeness,
upstream event impossibility, watermark consistency or source
availability without authoritative source-gap/health evidence.
Cross-source missing events and unknown source availability remain
inconclusive. Semantic budget truncation is not materialized on the
canonical Pattern match record: this slice cannot reliably report it,
and does not invent such metadata. See #166 C for gap propagation
and #44 for budget proof.

Deterministic test: `test/trigger-inspector-diagnosis-v1.test.mjs`.
It checks twelve status transitions, dead-letter, suspended state,
deadline boundaries, payload redaction and equivalent inspector
projections from two separately instantiated stores. No new
retention, database schema, authority or model dependency is added.
Full #48 acceptance still requires runtime source/gap state, bounded
high-cardinality read guarantees, tracing failure chaos and review.

**Delivery failure correlation:** a failed wake may be `dead_letter`
without a `firedWakeId` on the match. Inspection **prefers** the persisted `firedWakeId` when present,
otherwise derives the same stable wake ID from selected match ID + target
runtime/ID as the composite wake coordinator, then reads `latestWake(wakeId)` (one keyed
lookup, not an unbounded wake scan). A `conditionOnly` match with no
effect reports `condition_satisfied`, not `effect_pending`. The
stdio `inspect` and nested `simulate.inspection` output contracts
both require and validate the versioned diagnosis shape.
