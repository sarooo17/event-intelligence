# Inspector replay under an independent OS process — #48

The same trigger store is inspected in the original Node process and
then reinitialized by a **new Node OS process** after a complete JSONL
store close. The independently launched process uses only persisted
state; it receives the store path, not a precomputed explanation.

The regression `test/trigger-inspector-os-process-replay.test.mjs`
checks two real Pattern AST v2 scenarios:

- Partial conjunction: only an initial PR event has been seen. The
  missing deployment clause is not evidence that deployment will never
  happen; `diagnosis.kind=pattern_pending` and
  `sourceCertainty=unverified`.
- Completed structural event match with **no downstream host wake**:
  `diagnosis.kind=effect_pending`, and `wake=null`; neither an
  external effect nor a delivery receipt may be fabricated.

Inspections request bounded match history and evidence references.
They must be JSON-deep-equal before/after process restart and a
subsequent third store reopen. Untrusted event data and attempted
policy instructions must remain outside the explanation; the causal
timeline must state `upstreamCompleteness=unknown`.
The JSONL audit chain also verifies after reopening.

Existing `test/postgres-inspector-restart.test.mjs` separately checks
actual PostgreSQL 16 pool teardown/reopen and owner/tenant scoping
across identical IDs. Combined, these are **bounded restart/replay
correctness witnesses**. They do not certify real provider uptime,
completeness of external events, strict failover RPO/RTO or unauthorized
direct low-level inspector calls (hosts must enforce the read guard).
No runtime API or store schema changes are made.
