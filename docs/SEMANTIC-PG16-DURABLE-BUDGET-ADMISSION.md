# Host-owned durable semantic admission (#49)

A Pattern v2 semantic node may have a host-supplied
`semanticAdmission.reserve({namespace,nodeId,candidateSignature,
evaluatorIdentity,inputBytes,instructionBytes})` capability. The
canonical evaluator invokes this **only on a cache miss**, after the
deterministic Pattern child/prefilter, immediately before an external
model call. It supplies **counts and stable reference IDs**, no event
payload or projected model input. `false` means no provider call,
`truncated:true`, and no fabricated semantic rejection. A throwing
or malformed admission guard fails closed before the provider call.
Durable cached decisions do not consume additional admissions.
`CompositeTriggerEngine(...,{semanticAdmission})` passes the
capability through the generic host runtime; no agent or model SDK.

The optional `createPostgresSemanticAdmission` adapter accepts a
scope-bound EI PG16 store, `batchId`, host-selected `budgetEpoch`,
six trigger/batch limits (calls, upper-bound tokens, upper-bound
cost in micro-currency units), and a **trusted host estimator** that
returns `{tokens,costMicros}` upper bounds per call. It atomically
locks the trigger/epoch in PostgreSQL, reads both counters, checks all
six limits and updates both counters in one transaction. Independent
PG pools and workers serialize on the same scope lock. A denied,
malformed or corrupt reservation never invokes a model. Tests use
two real PG16 pools, concurrent reservations, tenant isolation,
different batches and a fresh pool after restart.

## Authority and scope limits

- The host owns evaluator implementation, actual model pricing,
  worst-case token/cost upper-bound estimator and approval policy.
  **EI cannot guarantee actual billable token or provider cost from
  an inaccurate estimator.** The limit is on host-reserved upper
  bounds, not a post-call billing reconciliation.
- Reservations are counted **before** a model call. Failed calls and
  worker crashes may consume unused budget; this is intentional
  fail-closed overcount, preventing the undercount that would arise
  from granting retries for free.
- The caller must generate a stable, distinct `batchId` for each
  evaluated batch and select a suitable `budgetEpoch` for the
  trigger's desired accounting window. A new epoch explicitly resets
  allowance; it is an operator authority, not inferred from event text.
- The PostgreSQL store is scope-local; tenant isolation uses its
  mandatory `scopeId`. The reference JSONL store deliberately has
  **no** distributed multiworker budget guarantee.
- Admission never authorizes a host tool call, continuation, or
  write; wake delivery still passes the host's own permission checks.
- `timeoutMs` already bounds the **awaited evaluation** but does not
  guarantee provider-side cancellation/billing after a noncancelable
  request times out. Hosted adapters need their own hard request
  limits, cancellations and network credentials.
- The PG budget record kind requires an operator-managed retirement
  plan for old budget epochs. No automatic pruning of production
  accounting records is introduced here.

This work advances #49 acceptance #3 but does not certify true
provider billing under adversarial pricing or all-host cross-region
budgets. A redacted real-source corpus is still required for #1, and
sampled notification-quality/SLO evidence remains separate.

## Host estimator timeout (EI-side only)

The opt-in PostgreSQL semantic admission gate now has `maxEstimateMs`
(default 2000, allowed 10..30000). A host-estimator timeout denies the
reservation (returns `false`) and therefore never starts a provider call;
an estimator error also fails closed. The timer is cleared on settlement.
This deadline does not cancel a host callback that ignores cancellation or
certify actual remote provider billing, server-side model limits or aborts.
A host should never put billable side effects inside its cost estimator.

The external provider billing/reconciliation proof required for #49's final
acceptance remains outstanding.

## Durable opt-in per-call reservation receipts (#49)

A host may pass a stable `reservationId` with each evaluator admission.
The PG16 transaction atomically stores a payload-free
`ei.semantic-reservation.v1` row alongside trigger and batch counters.
The receipt is keyed by a **SHA-256 digest** of the host request intent
within the scoped trigger namespace and policy epoch, including only
hashes of other identities, the reserved worst-case tokens/cost, pinned
policy fingerprint, and authoritative database admission timestamp.
Repeated IDs are **denied** across workers, batches, and pool/process
restarts; duplicate admission never creates another billable call.
A new ID is needed for a genuinely new provider request, including a
retry that may be billed separately. This is conservative once-only
admission, NOT automatic replay/reissue of a crashed or lost call.

The receipt deliberately says `reserved_billing_unknown`. It is NOT a
provider billing receipt or evidence that cancellation succeeded. A host
must reconcile provider-generated request IDs, actual token usage,
price-version and any in-flight/unknown charges separately before claiming
hard billable cost. Legacy callers without `reservationId` are unchanged.
Real PG16 two-pool/foreign-tenant/restart adversarial tests cover uniqueness,
resource reservation, opaque identity and old API compatibility.
