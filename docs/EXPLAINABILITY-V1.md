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
