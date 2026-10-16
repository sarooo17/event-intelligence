# #166 C — source gap versus negative CEP finality: reproducible failure

Status: **diagnostic witness / known unsafe behavior**, not an accepted
security or correctness fix. This test-first PR must not be mistaken for
completion of #166 C. The companion implementation must invert the marked
unsafe assertions, preserve healthy controls and receive its own review.

`test/mcp-events-gap-negative-finality-repro.test.mjs` creates a real
`PersistentEventStore`, `CompositeTriggerEngine`, and
`TemporalDeadlineScheduler`; it registers a bounded
`notFollowedBy(job.started, job.failed)` trigger. In the clean control,
the timer at +4,000ms correctly finalizes the negative.

In the failure witness, before that deadline the store contains
`mcp_client_state.truncated:true` for the precise forbidden MCP source
(`serverId:'upstream'`, `eventName:'job.failed'`, args `{}`).
The timestamp and subscription provenance are durable, and JSONL reopen
restores the gap. Yet the engine's deadline path still emits a matched
negative: it reads only the trigger's observed source events and the
temporal deadline, not the relevant MCP client state. This is an
**untrustworthy absence conclusion**, not merely an additional truncated
`evaluatePatternV2` candidate.

The source-state fixture is created directly via the canonical durable
store API (not through a live remote poll). Poll/push/webhook *labels* in
the matrix simulate the common persisted gap state; they are **not**
end-to-end producer transport conformance tests. Real poll and
push/webhook adapters already persist `truncated` to MCP client state,
but require separate adversarial callback and reconnect tests.

| Witness | Expected in current code | Correct future requirement |
| --- | --- | --- |
| No gap, no forbidden event | Negative fires | Negative may fire |
| Relevant gap before deadline | **Negative fires (unsafe)** | Inconclusive / no wake until verified reconciliation |
| Gap retained over physical store reopen | **Negative fires (unsafe)** | Gap-aware durable finality gate |
| Gap on unrelated server/event | Negative fires | Unaffected trigger continues |
| Gap learned *after* finality | Earlier result remains | Define reconciliation/compensation policy; cannot undo effect |
| Two independent JSONL scope stores | No state sharing | Preserve tenant/scope isolation |

**Required fix design before implementation:** use bounded, canonical
per-scope subscription/source identity and durable gap provenance. Determine
which negative AST branches depend on a gap-affected forbidden source;
do not globally stop independent triggers, partitions or unrelated
positive OR branches. Keep source delivery gaps distinct from evaluator
work-budget `truncated`. Couple the finality guard to the point **before**
a negative match is persisted / wake enqueued, and preserve retryability
for pending temporal deadlines across restart. Do not reset a historical
gap to "healthy" merely because the next `events/poll` reports
`truncated:false`: explicit authoritative replay/repair evidence is
required. Host owns authorization and final side effects. When a gap is
discovered *after* an irreversible wake, define a host reconciliation
policy instead of claiming impossible retroactive guarantees.

This PR adds no new runtime migration, protocol field, source-of-truth
claim, npm release, or Artemis/Muffin change. SEP-3415 is still a draft.

### Review-hardening of fixture provenance

The diagnostic clock picks its event-time anchor one hour **after** the
real write timestamp, then asserts that the persisted `updatedAt` of the
gap precedes the pending deadline. `lastEventAt` remains the last accepted
source event timestamp; it is **not** incorrectly treated as gap detection.
The unrelated-identity controls separately vary only the server, only
the event name, and only the subscription arguments, as well as the
original fully unrelated source. Finally, two tenants use
`PersistentEventStore.forScope()` beneath one shared root, and isolation
is rechecked after physical reopen. These controls are required for a
future canonical connection/source matching implementation.
