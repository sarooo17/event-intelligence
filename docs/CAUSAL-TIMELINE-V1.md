# Reference-only causal timeline v1 (partial #48)

`TriggerInspector.inspect()` now returns an additive `causalTimeline` property with `contract:'ei.causal-timeline.v1'`. Only a **host-authorized**
inspector invocation may access it. EI does **not** independently authorize
low-level inspector reads; host ACL checks must run before choosing a scoped
store and invoking inspection.

The timeline contains at most **32 source-occurrence references** and three
persisted-stage markers (match, wake, receipt). All event, clause, trace, match,
wake and host receipt identifiers are mapped to truncated SHA-256 references
rather than copied raw; no payloads, descriptions, provider text, instructions,
semantic rationale or target context are included. Source entries are sorted
deterministically by hashed clause and source IDs, independently of the backing
store's iteration order.

The returned schema also includes `sourceCount`,
`sourceTruncated`, `sourceLimit` and a deliberate
`upstreamCompleteness:'unknown'`. A recorded wake is **not**
proof the external side effect happened; `host_receipt_recorded`
appears only when EI's *persisted* wake state contains a host receipt ID.
Missing source entries cannot establish whether a remote event was absent.
This deliberately does not claim the full why-not-fired taxonomy, complete
cross-worker tracing, sampling economics or OTel export.

The existing `lineage`, `diagnosis` and `why`
fields remain untouched for pre-v1 consumers. Host owners choose whether to
render or hide this timeline. There is no new model dependency or telemetry
emission, so enabling/disabling observability does not affect matching or wake.

Tests: `node --test test/trigger-causal-timeline-v1.test.mjs`.
Full #48 still requires source/watermark/budget negative-state coverage,
tenant authorization tests for every exposed read entry point and operational
cost evidence.
