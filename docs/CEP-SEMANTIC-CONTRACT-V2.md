# Pattern AST v2 — canonical semantic contract and evidence coverage

**Scope and authority.** This is the public implementation contract for the
single canonical `PatternAstV2DefinitionSchema`, not a new DSL and **not** a
proof that every composition is production-certified. Normative sources:
`src/intelligenceProtocol/patternV2Schemas.ts`,
`src/patternV2/evaluator.ts`, and the selection/partition integration in
`src/composite/engine.ts`. The explicit finite differential corpus is
documented in [CEP-CONFORMANCE-MATRIX.md](./CEP-CONFORMANCE-MATRIX.md).

Evidence levels below mean:
- **Differential subset**: independent reference oracle plus bounded source
  permutations; only the written subset is proven by these tests.
- **Behavior test**: direct example, regression, or adversarial assertion
  against the implementation; no independent exhaustive reference model.
- **Gap**: important combinations or temporal failure semantics still need
  an independent oracle or integration/chaos evidence.

## Node contracts

Every `kind` in the canonical schema has exactly one row in this section.
A source/schema drift regression verifies the catalogue remains synchronized.

| Node | Observable implementation contract | Evidence level and reference | Outstanding gap |
| --- | --- | --- | --- |
| `event` | Produces a candidate for each event bound to its declared reference; original event identity remains in bindings. | Behavior test: `test/pattern-v2.test.mjs` | Malformed/duplicate identities in arbitrary nested compositions |
| `allOf` | Combines candidates from all children if their physical event identities do not overlap. Intermediate combinations are subject to candidate budget. | Differential subset: `test/pattern-v2-allof-oracle.test.mjs` | Deep nested combinations |
| `anyOf` | Unions child candidate sets, deduplicating them under the candidate cap. | Differential subset: `test/pattern-v2-anyof-oracle.test.mjs` (disjoint refs); behavior test: `test/pattern-v2-anyof-repeat-mode-contract.test.mjs` (overlapping arms, cap/identity) | Combinations with nested negatives and selection |
| `sequence` | Child candidates must progress in event-time index order. `next` requires adjacency, `followedBy` chooses the first compatible continuation, and `followedByAny` allows compatible alternatives; optional child preference affects ordering. | Differential subset: `test/pattern-v2-oracle.test.mjs` for `next` and `followedBy`; behavior test: `test/pattern-v2.test.mjs` | Independent `followedByAny`/optional/selection cross-product |
| `repeat` | Enumerates eligible child units under `min/max`, `consecutive`/`relaxed`/`combinations` and greedy/lazy output preference; exhausted candidates set truncation. | Differential subset: `test/pattern-v2-repeat-oracle.test.mjs` (finite event units, min/max 1..3); behavior test: `test/pattern-v2-anyof-repeat-mode-contract.test.mjs` (greedy/lazy ordering) | `min=0`, unbounded/high-cardinality and repeated nested child patterns |
| `optional` | Includes a no-events candidate and child candidates; greedy/lazy controls their precedence for downstream sequence choice. | Behavior test: `test/pattern-v2.test.mjs` | Independent nested optional and after-match cross-product |
| `notNext` | Removes a base candidate if a forbidden candidate starts at the immediately following event-time index. This is a **finite snapshot** test, not irreversible negative finality. | Differential subset: `test/pattern-v2-notnext-oracle.test.mjs` | Late appended occurrences and stream-finality guarantee |
| `notFollowedBy` | Forbids candidates starting strictly after the base anchor and completing on/before its inclusive deadline. An unblocked result is pending until deadline + allowed lateness. | Differential subset: `test/pattern-v2-negation-oracle.test.mjs`, `test/pattern-v2-dst-negative-oracle.test.mjs`, `test/pattern-v2-finality-monotonic-oracle.test.mjs`, `test/pattern-v2-evolving-negative-ingress-oracle.test.mjs` (changed-corpus late arrivals) | Host/store watermark and irreversible delivery with changing late evidence; nested negatives |
| `window` | Filters bound candidates by `within`, `sliding`, `tumbling`, `hopping`, `session` or `count` constraints measured in event time/chronological indexes. | Differential subset: `test/pattern-v2-window-allof-oracle.test.mjs` (one-level `allOf`) | Deeper nesting, session groups larger than two, adversarial boundaries |
| `calendar` | Filters the latest event bound to `ref` against IANA-timezone local clock/date/weekday constraints. | Behavior tests: `test/temporal-conditions.test.mjs` (host local-clock cutoff), `test/pattern-v2-calendar-date-weekday.test.mjs` (weekday-only, date-only, intersection and mismatch at the same local clock) | Independent calendar/DST property corpus across IANA zones |
| `absence` | After the bound anchor, forbids a reference event from anchor through due time inclusive; if still absent, waits until due + allowed lateness. | Behavior test: `test/pattern-v2.test.mjs`, `test/temporal-conditions.test.mjs` | Independent IANA/local-time due oracle and late-arrival lifecycle |
| `notPresent` | Rejects a child candidate when a forbidden-ref event has an event-time index within the candidate's inclusive span. | Differential subset: `test/pattern-v2-nested-notpresent-oracle.test.mjs` | Arbitrary nested child/forbidden compositions |
| `after` | Keeps a child candidate only when the latest bound `ref` event is strictly later than the latest `afterRef` event. | Behavior test: `test/pattern-v2-after-until-debounce.test.mjs` (before/equal/after boundary) | Independently enumerated repeated-reference ordering |
| `until` | Keeps a child candidate only when the latest `ref` is at/before the latest `beforeRef` event. | Behavior test: `test/pattern-v2-after-until-debounce.test.mjs` (inclusive equality) | Independent nested/repeated boundaries |
| `debounce` | Binds the latest ref event; candidate remains pending until latest event-time + `forMs` + allowed lateness. | Behavior test: `test/pattern-v2-after-until-debounce.test.mjs` (clock and new event boundaries) | Restart and late-arrival monotonicity across timer updates |
| `threshold` | Requires at least `atLeast` **distinct physical source occurrences** of `ref` and unions the earliest required unique witnesses with any bindings already supplied by its child for the same `ref`; replay copies do not increase the count. | Behavior tests: `test/pattern-v2-threshold-witness.test.mjs`, `test/pattern-v2-threshold-rate-physical-replay.test.mjs` (replays, cross-server ID collisions and exact bindings) | Independent high-cardinality and crossing-threshold oracle |
| `rate` | Counts **distinct physical** ref occurrences in the inclusive `perMs` interval ending at latest event time; unions the last `atLeast` unique witnesses with any child bindings for the same `ref`, ignoring replay copies. | Behavior tests: `test/pattern-v2-rate-window-witness.test.mjs`, `test/pattern-v2-threshold-rate-physical-replay.test.mjs` (replays, cross-server identity, exact inclusive-window bindings) | Independent rolling-window differential and partition adversaries |
| `distinct` | Collects earliest distinct primitive string/number/boolean values at `path` for `ref`; binds `atLeast` witnesses, excluding unsupported field types. | Behavior test: `test/pattern-v2-distinct-witness.test.mjs` (duplicate, primitive, invalid-path, bound witness and arrival permutation checks) | Larger reference/aggregate compositions and edge-case collisions |
| `compare` | Evaluates arithmetic, field, timestamp or literal operands against an explicit comparison operation on child candidates. | Behavior test: `test/pattern-v2.test.mjs` | Independent numeric/invalid-value/metamorphic oracle |
| `aggregate` | Computes the configured numeric aggregate on the bound reference and filters with a numeric comparator. | Behavior test: `test/pattern-v2.test.mjs` | Independent aggregate/repeat/window edge corpus |
| `state` | Filters child candidates using a configured state/transition predicate over reference events. | Behavior test: `test/pattern-v2.test.mjs` | Independent state-transition oracle under repeated events and reordered ingress |
| `semantic` | Applies explicit bounded semantic predicate to projected owned fields. A cached decision can satisfy a candidate without a new model call; unavailable evaluator defaults to error unless the author explicitly chose `onUnavailable:reject`. Provider timeout/errors are not complete no-match outcomes. | Behavior test: `test/semantic-scope-budget-conformance.test.mjs`, `test/pattern-v2-semantic-cache-budget-order.test.mjs`, `test/pattern-v2-semantic-failure-matrix.test.mjs` | Provider cancellations/retries, distributed cache faults and compositional mutation corpus |

## Cross-cutting execution contracts

1. **Event time and ordering.** The standalone evaluator sorts inputs by
   `Date.parse(occurredAt)`, then source ID, then clause ID, rather than by
   processing arrival. Most independent oracles deliberately restrict
   equal-timestamp ties to simplify their proof domains; tie-breaking is part
   of the implementation but not universally independently proved. DST
   witnesses use explicit offsets and absolute instants.
2. **Processing clock and negative finality.** `now` is the evaluation clock;
   `allowedLatenessMs` defers negative/debounce/absence finality by the
   configured allowance. A finite snapshot match does not automatically
   prove future absence under newly arriving late events. Persisted
   timers, wake behavior and watermark advancement belong to host integration.
3. **Budgets and diagnostic outcomes.** `maxCandidates` caps **retained
   candidates at deduplication checkpoints**, but does **not** currently
   bound peak candidate generation or memory usage: `allOf` now
   streams its unique Cartesian combinations and stops at the first
   over-cap candidate (#159), and `event` limits generation to the
   first `maxCandidates` unique physical events (#160). However, `sequence`
   intermediate combinations and other operators can still materialize
   more candidates than the configured cap. Input sorting and buffers are
   not covered: this remains **not** a global CPU/memory resource budget.
   `maxSemanticEvaluations` bounds **new** semantic model calls.
   Reusable exact cache decisions do not consume the call budget.
   Exhaustion may return a partial set with `truncated:true`, even when
   `matches:[]`. Hosts **must not** interpret a truncated empty result as
   complete no-match. `pending` means temporal finality not yet achieved.
   An evaluator error/timeout rejects the call, not an ordinary empty result.
4. **Partition handling is host-specific.** `evaluatePatternV2` evaluates
   the supplied event collection; it does **not** partition inputs merely
   because `definition.partitionBy` is populated. Partition keys,
   durable buffers, owned source identities and optional distributed leases
   are implemented in `CompositeTriggerEngine`. The finite JSONL
   partition/restart reference test is
   `test/pattern-v2-partition-restart-oracle.test.mjs`; multi-worker PG
   chaos/load evidence remains under #47.
5. **Selection is host-specific.** `selection.overlap`,
   `selection.afterMatch`, and `selection.maxMatchesPerEvent` are applied
   to fresh candidates by `CompositeTriggerEngine`, along with lifecycle
   limits (one-shot, max firings, cooldown). The standalone evaluator's
   candidate set should **not** be mistaken for the final delivered matches
   of a production host. Independent full selection-policy cross-product
   coverage remains open.
6. **Replay and identity.** Evaluator **and composite host** use the same
   stable, unambiguously encoded tuple of server ID, source-event ID and
   canonicalized subscription arguments. Persisted candidate-signature
   tuples use locale-independent Unicode code-unit sorting. `threshold` and `rate`
   count distinct source identities consistently with the returned bindings;
   replay copies cannot fabricate additional occurrences. The count's
   selected witnesses are **unioned with a child's existing bindings** if
   the child already binds that reference, so the final candidate may
   legitimately contain more than `atLeast` bound events. Bounded JSONL
   replay/reopen evidence is exercised by
   `test/pattern-v2-partition-restart-oracle.test.mjs`; this is not a
   global exactly-once guarantee.
   **Signature compatibility decision (pre-v1):** changing from
   delimiter-joined signatures to self-delimiting JSON tuples alters
   `patternV2CandidateSignature`, which is used for persisted match
   identities and pending-deadline condition IDs; it may also invalidate
   derived semantic-cache keys. This update deliberately adds **no legacy
   signature compatibility layer**. Before adopting it in a host with
   existing Pattern v2 state, pause that host, reset/replay affected
   match/pending-deadline state and invalidate derived semantic decisions,
   then rebuild timers under the new signature format. Release/migration
   acceptance remains tracked by #50. No existing consumer is updated by
   this PR.
7. **Trust and versioning.** The only AST is version `2`; the schema contract guard requires immutable
   lexical aliases and rejects uninspected object-spread/computed-key forms. Semantic evaluators
   receive projected event content and no new runtime privileges. This
   document is an implementation contract, **not** authorization to use
   remote payloads as instructions. No additional execution DSL is implied.

## Acceptance coverage vs certification

The catalogue above satisfies **the written operator-to-test-category
mapping**, whether independently proven or explicitly outstanding. It does
not claim full formal verification. Remaining #44 evidence includes deeper
nested/selection operator composition, adversarial late-event/timer changes,
evaluator-level mutation testing, and safety-cap properties at larger
cardinalities. Operational distributed persistence and recovery are also
tracked by #47. The conformance report and corpus must be pinned to an
actual reviewed commit before a release is called production-ready.
