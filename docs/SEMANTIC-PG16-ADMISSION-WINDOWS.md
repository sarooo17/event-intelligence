# Host-owned semantic admission deadlines — PG16 and monotonic batch clock

The optional generic `createPostgresSemanticAdmission` ledger now supports
`maxTriggerWindowMs` and `maxBatchWindowMs` (10–86,400,000 ms), alongside
persisted call, reserved-token and reserved-cost counters. These are **maximum
admission windows from the first successful reservation**, *not sliding TTLs*.
The first reservation persists `deadlineAtMs` under the existing
scope/trigger/epoch advisory lock using **PostgreSQL clock_timestamp()**, so
multiple pools, workers, host clock changes and a restarted process cannot
extend the window. Every reservation after either deadline refuses the call,
including from a fresh batch after its trigger window expires.

Changing from an existing non-windowed ledger to a windowed ledger requires
the host to choose a **new explicit budget epoch**; silently replacing old
counters with a fresh deadline fails closed. Once a window exists in the
ledger, disabling an optional configured limit cannot erase its durable
deadline. Corrupted counter/deadline values also fail closed.

The canonical `evaluatePatternV2` additionally accepts optional
`maxBatchElapsedMs` (10–600,000 ms); `CompositeTriggerEngine` exposes
`semanticMaxBatchElapsedMs`. A monotonic process-local deadline measured at **function entry** limits
preprocessing, admission and the awaited model request; no external model call starts if
a slow admission callback exhausted the batch time, and an inconclusive
`truncated:true` is returned instead of false-negative classification.
The call's awaited timeout is the minimum of its existing semantic node
timeout and remaining batch time. Its clock is independent from virtual
source-event timestamps.

**Limitations:** A timeout of an awaited promise does not guarantee that a
provider-side billable request is cancelled. The host must implement network
abort/cancellation in the evaluator, conservatively reserve provider-cost
ceilings before any call, and use an authenticated provider billing receipt
if it wants actual-spend certification. The database window prevents *new*
admissions after expiry but cannot retroactively terminate a request that
started before expiry. Both time budgets are opt-in and backwards-compatible.

Evidence: real PG16 two-pool concurrency and persisted ledger restart
regressions plus a new DB-clock expiration/restart/new-epoch test; canonical
evaluator regression with deliberately slow admission proves no external
model call starts after elapsed batch budget.

## Review hardening

The cumulative timer begins before input sorting and event indexing; 50,000 valid source events may consume the batch allowance before any provider admission. A timer expiry while an already-started semantic evaluation is awaited is an **inconclusive** `truncated:true` result, not an escaping node error. The pre-existing per-node timeout error retains its prior behavior. This does not guarantee cancellation of an already issued provider request, so the budget ledger reserves cost pessimistically before sending it.
