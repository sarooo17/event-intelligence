# Versioned evidence-gated explanation reasons (#48)

The existing `diagnosis.contract = ei.trigger-inspection.v1` is unchanged.
An **additive** `diagnosisV2` object carries
`ei.trigger-explain-reason.v2`. Its normalized `kind` distinguishes:

- `not_yet_satisfied` when no conclusive local Pattern evidence exists;
- `paused` and `lifecycle_ended` from persisted trigger lifecycle;
- `candidate_expired` for the *selected match*, not all potential future matches;
- `deadline_pending` from a stored pending temporal deadline;
- `wake_failed` from an actual dead-letter wake;
- `waiting_delivery` for a target-bound matched trigger, or `condition_satisfied`
  for matched condition-only triggers with **no runtime delivery**, plus
  `fired`, `derived_emitted` from durable terminal states;
- `source_unavailable`, `watermark_pending`, `source_gap_unresolved`, `budget_truncated`, and
  `candidate_impossible` **only if a trusted, scoped store provides
  extra durable explanatory evidence.**

The optional store-side method
`getInspectionFact({triggerId,triggerVersion,matchId})` must return an own
data object with contract `ei.inspection-fact.v1`, the exact requested
trigger ID/version/match ID, `durable:true`, and one of those four reason
kinds. `candidate_impossible` additionally requires a selected match
and `terminal:true`: impossibility of a selected candidate is not proof
that no future provider event can ever match.

Absent, malformed, wrong-scope, accessor/proxy-backed or untrusted
provider-event facts are **ignored**, yielding
`not_yet_satisfied` rather than fabricated certainty. The default
PostgreSQL and JSONL stores do **not** yet persist this new fact kind.
Hosts choosing to support it must produce it from separately verified
source-health, gap/watermark, evaluator budget or formal terminal evidence,
never from model prose or raw event fields. `upstreamCompleteness`
always stays `unknown`: EI does not know what happened outside its
observed event stream. `basis` and `scope` make each diagnosis's
provenance explicit without copying raw evidence or credentials.

This is an API/contract **partial implementation**, not a claim that
all four external/semantic evidence-producing adapters now exist.
That remaining integrated proof is necessary to check #48's first
acceptance. Tests cover the state taxonomy, supported scoped facts,
negative spoof/wrong-tenant/wrong-version cases, lost evidence and
existing `diagnosis` v1 compatibility. Host security/authorization remains
outside the low-level inspector.

## Host-verified event-time frontiers (opt-in PostgreSQL, #48)

A trusted **host adapter**, not an MCP event payload, may call
`PostgresEventStore.recordVerifiedInspectionFrontier` after its independent
`verifyProof` callback confirms that the provider guarantees *complete
source delivery through an event-time frontier*. Proof contents and raw
provider secrets are not persisted, only the SHA-256 digest of an opaque
proof reference, source identity, source completeness revision and
canonical event-time frontier. The transaction locks the same source gap
fence as MCP client-state updates and refuses a stale, gap-affected or
unavailable source or a regressing frontier. Stored evidence is invalidated
when any subsequent poll advances the source revision, including after
restart.

The inspector may now produce `watermark_pending` or
`candidate_impossible` ONLY for a selected **partial** match with a
pure, complete `allOf(event ...)` AST and a verified, revision-current,
gap-free frontier for **every missing clause**. If all frontiers are
strictly beyond the candidate expiration and event-time allowed lateness,
that **specific candidate** is impossible to complete; otherwise it is
waiting for a certified watermark. Nested OR, sequence, negation, semantic
nodes, insufficient/malformed/stale proof, incomplete bounded inventory,
or missing match identity conservatively report unknown/local pending.
`upstreamCompleteness` stays `unknown`; a terminal selected candidate
is NOT proof that every future upstream event is impossible.

A host's `verifyProof` is a trust boundary and must check actual provider
semantics, source identity, authentication and complete delivery including
replay/reconciliation. The reference PG16 tests exercise a trusted verifier
stub with real durable store, multiple tenants, gap invalidation and pool
restart; they are **not** third-party provider certification. #48 acceptance
#1 is not checked until a real source/host independently verifies and
exercises authoritative completeness guarantees.
