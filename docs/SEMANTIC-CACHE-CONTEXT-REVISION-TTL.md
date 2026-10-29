# Semantic evaluator cache: optional host-owned revision and lifetime

The canonical Pattern v2 semantic evaluator is optional. The host may
construct `CompositeTriggerEngine(store, evaluator, now, {
semanticContextRevision, semanticCacheTtlMs })`, or pass
`semanticContextRevision` and `semanticCacheTtlMs` directly to
`evaluatePatternV2`.

* `semanticContextRevision` is a bounded (at most 128-character)
  **host-trusted** string. Increment it whenever acceptance criteria,
  summary context, prior important notification or confidence threshold
  needs to invalidate old decisions. This is distinct from the trigger
  definition's own version and evaluator's `cacheIdentity`.
* `semanticCacheTtlMs` is an opt-in 1000..86400000-ms cache lifetime
  **bucket**. Cache keys embed
  `floor(evaluationNowUTCms / semanticCacheTtlMs)`, so decisions
  remain reusable during the current bucket and are not reused across
  later buckets. This is fixed-boundary expiration, **not** per-entry
  expiry since the original write. For a firm maximum age, hosts must
  also ensure their evaluation clock does not move backwards, or
  provide stricter store-level expiry. An old bucket may become
  reachable again if the host rewinds its clock; do not describe this
  as wall-clock rollback-proof.
* When either new option is set, a separate
  `pattern-v2-semantic-cache.v2` key is used, preventing collisions
  with legacy cache v1 entries. With both options defaulted, the
  original exact v1 key is retained for full backwards compatibility.
* Cache keys still include the evaluation node/criteria, host
  `cacheIdentity`, scope/trigger/version namespace and the
  **physical source IDs plus server and canonical subscription
  arguments**. PG16/JSONL stores remain scope-local. Hosts must supply
  distinct scope namespaces to custom shared stores.
* A cache hit consumes **zero new model calls** and does not consume
  the call budget. A miss over `maxSemanticEvaluations` reports
  `truncated:true`, never a conclusive no-match. Without an evaluator,
  deterministic conditions keep working and semantic nodes honor their
  explicit `onUnavailable` policy; EI never starts an agent loop.

Tests exercise persisted JSONL close/reopen, policy revision and
tenant namespace changes, TTL-window expiration, malformed budget
configuration, and two independent optional-host runtime modes,
including a host with no semantic evaluator and no automatic writes.

**Remaining #49 items:** this does not establish actual provider
token/monetary spend caps, concurrent cross-worker durable reservations
or a real-redacted quality corpus. The host must supply these controls
for external model execution, and they need independent conformance
proof before #49 acceptance #1 or #3 can close.
