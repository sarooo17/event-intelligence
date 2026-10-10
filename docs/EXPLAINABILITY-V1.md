# Bounded trigger explanation (first implementation slice)

Tracking [#48](https://github.com/sarooo17/event-intelligence/issues/48).

`TriggerInspector.inspect()` already exposes pattern, lineage refs, status and event-time deadlines. This slice adds machine-readable **observed/waiting clause progress** and bounds the *serialized* match history.

## Output

The inspector now returns:

```json
{
  "progress": {
    "evidenceBasis": "latest_match_only",
    "observedClauseIds": ["merged"],
    "waitingClauseIds": ["deployed"],
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

The example is illustrative. `observedClauseIds` only indicates evidence attached to the selected latest match. **It does not assert the entire Pattern AST is satisfiable or that missing events never happened externally.** Pending deadlines come from the current scoped store.

The history window contains the most recent 100 records by store-provided order by default. Host operators may configure `matchHistoryLimit` as an integer from 1–500; invalid or unbounded values throw. A `historyTruncated` flag communicates when the projection omitted older records. Full history remains available only via the authorized store's history API.

**Limit:** The store's current history API is not paginated; this slices results after the read, bounding response serialization but not DB read cost. Storage-side cursor pagination and retention still belong to [#47](https://github.com/sarooo17/event-intelligence/issues/47).

No raw source-event payload is added to these fields, and no model is involved in producing explanations. The host remains responsible for restricting inspection to authorized owners/tenants.

## Test

```bash
npm run build
node --test test/trigger-explain-bounds.test.mjs
```

Remaining #48 work: versioned explain contract; unavailability/watermark/truncation distinctions; bounded store queries; causal trace correlation; redaction validation and optional OTel bridge.
