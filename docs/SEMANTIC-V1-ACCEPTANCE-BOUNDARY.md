# Stable-v1 semantic budget acceptance: host reservation vs provider invoice

Decision: **semantic evaluation remains runtime opt-in**, while budgeted
admission correctness is a required stable-v1 SDK contract (#41/#49).
A provider invoice is **not** a prerequisite for verifying host-controlled
reservation ceilings. That is narrower than guaranteeing the provider's
final billed charge.

## Enforced at the EI/host boundary

- Before model dispatch, a host-supplied bounded worst-case estimator
  provides the token and micro-USD **reservation**. PostgreSQL16
  atomically enforces per-trigger and per-batch calls, tokens, estimated
  cost and time windows across pools, scopes and process restarts.
- A timeout, malformed provider response or uncertain cancellation
  retains the complete reservation, without automatic retry or refund.
  A host explicitly authorizes a new budget epoch for new spend.
- Provider adapters own actual model allowlists, input-token preflight,
  output caps, remote deadlines and their credentials, not EI core.
- On Railway staging a real OpenAI Responses call returned completed,
  independently GET-verified usage of **14 input + 11 output tokens**
  and within-reservation status. A subsequent exhausted reservation
  returned admission_denied with zero additional provider calls.
- Existing PG16 tests verify cross-worker atomicity, restart, quotas,
  policy fingerprint, corrupt input, estimator timeout, provider usage
  mismatch, unknown outcomes and refusal of replayed IDs. The new
  dedicated test also verifies new IDs cannot bypass an exhausted
  budget after unknown remote outcome in a distinct PG connection.

## Not guaranteed

- The EI cost ceiling is **admission on estimated worst-case host cost**,
  NOT a hard external provider billing limit, final settled invoice,
  or verified per-response charge. Remote provider billing can outlive
  a synchronous client abort.
- Actual provider-side cancellation/stop-billing was not demonstrated.
  Daily project admin cost reports aggregate other transactions, may
  settle late, and do not alone prove per-request charge attribution.
- A faulty/malicious provider can report more usage than estimated;
  EI preserves reservations and detects mismatch but cannot undo
  a remote overcharge.
- The tiny live test is not representative provider/host production SLO.

## Acceptance decision to review

The original #49 max-call/token/cost/timeout criterion should refer
to **strict reserved admission bounds**, under adversarial inputs and
restart, not to provider invoice settlement or ability to interrupt
remote billing. The SDK must continue to state billingConfirmed=false
for the real provider usage witness. This change never implies a
provider-side financial spend guarantee or independent security signoff.

This is a source/acceptance proposal until exact-final-HEAD CI,
independent review and the issue checklist reflect the scoped decision.
#317 external host security and #47 production SLO/retention are separate.
No stable npm release or automatic consumer update is authorized.
