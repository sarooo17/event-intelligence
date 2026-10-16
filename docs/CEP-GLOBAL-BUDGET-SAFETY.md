# CEP v2 — global resource safety and incomplete-result policy

**Acceptance slice for #44.** The standalone evaluator has a conservative
bounded execution envelope even when called outside a host buffer:

| Guard | Limit | Outcome on exhaustion |
| --- | --- | --- |
| Input event collection | 50,000 source entries per invocation | Zero matches and pending, `truncated:true`, **before sorting** |
| Pattern tree | 4,096 node occurrences, max depth 128, no cyclic object graph | Zero matches and pending, `truncated:true`, before recursive evaluation |
| Evaluation work | min(250,000, max(4,096, maxCandidates × 128)) counted node/inner join attempts | `truncated:true`; produced positive candidates are a potentially incomplete prefix, not a complete result |
| AnyOf | Streaming deduplication with at most `maxCandidates` retained outcomes | First extra unique candidate marks `truncated:true`, without materializing every child's candidate arrays |
| AllOf / sequence / repeat | Every explored join/compatibility step spends a unit of this shared work budget; repeat keeps its own stricter local work/depth cap | Prefix/incomplete evidence signaled, never silent complete no-match |
| Source-index lookups | Per-invocation weakly keyed first-position index map | Reuses O(1) physical-identity/claused index lookup rather than scanning all input events per candidate |
| `notPresent` and `absence` | Do not assert negative results when their child already returned incomplete evidence | Empty with `truncated:true`; the existing `notNext`/`notFollowedBy` fail-closed checks remain |

This work bound counts named hotspots and is a **conservative operational
counter**, not a formally measured upper bound for every arithmetic/regex,
date, semantic remote call, `Intl` implementation, or filesystem operation.
Other work uses fixed-size source/candidate/tree caps and must still be
covered by operational load testing. External semantic calls are already
limited by `maxSemanticEvaluations` and per-call `timeoutMs`; this
does **not** hard-interrupt remote promises outside that contract.

**Explicit pre-v1 migration decision:** the canonical AST remains version 2
and there is no new configuration, authority, storage schema or token. A
previously accepted input that exceeds the new 50k source/4096-node/128-depth
envelope, or whose nested candidate search exceeds the shared work cap, now
returns explicitly incomplete evidence instead of attempting unbounded work,
throwing stack errors, or silently treating excluded matches as absent.
Hosts MUST not persist a truncated *negative* result as final. For users of
larger buffers, partition or reduce the event window before evaluation and
replay the affected range; changing a persisted prior result requires a
replay/rollout decision. Physical-signature migrations are tracked separately
in #50. Resource load/chaos with PostgreSQL multi-worker orchestration is #47,
not claimed by this process-local finite test.

**Evidence:** `test/pattern-v2-global-budget-guard.test.mjs` includes
a shared-anchor nested `allOf` dead-end corpus where a larger scan becomes
incomplete instead of a definitive no-match, complete smaller negative
control, 50,001-event preflight witness, depth/width AST limit,
anyOf dedup/prefix behavior, and fail-closed negative operators.
