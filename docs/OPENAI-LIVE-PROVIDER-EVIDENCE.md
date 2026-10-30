# External OpenAI Responses validation — issue #49

**Optional validation-only host integration. The Event Intelligence engine and
published generic provider contracts remain provider-neutral.**

## What this can and cannot prove

The reference adapter under `scripts/validation/openai-responses-provider.mjs`
runs a single opt-in request through real EI PostgreSQL worst-case admission,
then through the official Responses API. It separately calls the OpenAI input
token-count endpoint before admitting, enforces `truncation:'disabled'`,
`max_output_tokens:32` (up to 64 allowed), and disables all tools.

One stable **host-owned reservation ID** is saved before attempting a
possibly billable request; after a network failure, timeout, malformed
provider response, unexpected model/status, or lost verification GET it is
**never refunded or automatically retried**. To retry a possibly billed
request, the operator must explicitly choose a new billable reservation ID
*and a new host policy epoch* and count it against the external bill cap.
Do not run this under a reused epoch thinking a failed HTTP call was free.

On success a new GET of `/v1/responses/{id}` compares the provider-issued
response ID, model, completion status, actual output cap and every usage
counter with the initial response. The existing EI PG reconciler accepts
only one externally issued response ID per tenant-scope and records opaque
digests, numeric usage and `billingConfirmed:false`. It never persists the
actual prompt, API key, raw response ID or model response text.

**Important:** HTTP API usage is not an independent invoice. The host token
reservation is not a provider-enforced money limit; the 100,000-micro-USD
(USD 0.10) reservation only limits EI-side admission. The provider may charge
for a timed-out request. The API output cap does not itself cap input
billability; the preflight count and request-size bounds are additional
host checks, not billing guarantees. An admin cost witness can read **daily,
project-aggregated** USD amounts but cannot attribute a daily charge to a
specific response or account for asynchronous invoice settlement.

## Run on a dedicated private Railway validation runner

1. Create a separate OpenAI API project with low model usage/spend limits
   and a restricted Responses API test key. Use only that project's
   credentials, **never** the main production project's key.
2. Provision a separate **private** Railway one-shot runner connected to the
   existing `ei-validation / staging` PostgreSQL instance; no public domain
   or inbound HTTP access is needed. Use Node and
   `node scripts/validation/run-openai-live.mjs`.
3. Configure these secrets directly in Railway (do not commit or paste
   them into a PR):
   - `DATABASE_URL`: private reference to the staging PostgreSQL
   - `OPENAI_API_KEY`: restricted key belonging to the isolated project
   - `EI_CONFIRM_LIVE_OPENAI_TEST=YES` (explicit one-shot opt-in)
   - `EI_OPENAI_TEST_BATCH`: stable nonsecret opaque test episode
   - `EI_OPENAI_TEST_RESERVATION`: unique stable request-intent identity
   - optional `EI_OPENAI_TEST_EPOCH`: pinned budget epoch, only change
     when intentionally authorizing an additional paid experiment
   - optional `EI_OPENAI_TEST_SCOPE` and `EI_OPENAI_TEST_TABLE_PREFIX`
     to isolate validation records from normal EI tenant records
4. Run at most **one billable model request** for the same namespace and
   budget epoch. The validation implementation currently supports
   `gpt-4o-mini` and a fixed harmless synthetic ticket string, up to 128
   counted input tokens, 32 output tokens and one 100,000-micro-USD
   *admission reservation*. It never sends or logs production data.
5. Archive the sanitized CLI JSON, scoped PG receipt and final-head test
   SHA. The CLI intentionally exits nonzero for any unknown/failed remote
   outcome, and never silently retries.
6. **Separate authorization:** an organization owner may supply a distinct
   OpenAI **admin** key to the read-only
   `createOpenAIProjectCostReader`, specifying the exact project ID and
   a whole-UTC-day interval. That adapter returns the project-filtered
   *daily aggregate* in USD (and micro-USD), with
   `perRequestAttribution:false` and `finalInvoiceCertified:false`.
   Do not grant the admin key to the model-calling process.
7. Reconcile after billing/usage aggregation settles. If the project was
   not fully isolated or any request's billed amount cannot be uniquely
   attributed, record **INCONCLUSIVE**. A request timed out locally is not
   guaranteed canceled remotely. The official Responses
   `POST /responses/{id}/cancel` applies to
   `background:true` responses; this synchronous reference runner
   does **not** claim that simply aborting fetch stops provider billing.

## Reproducible CI coverage

- `test/openai-responses-provider.test.mjs`: direct HTTP transport with an
  injected fake network, no secret logs, exact output cap, rejected overlong
  input, one real PG16 budget reserve/usage receipt, independent pool
  duplicate denial, tampered provider GET and unknown remote outcome.
- `test/openai-project-costs.test.mjs`: restrictive admin project filtering,
  daily-only UTC windows, fail-closed pagination, wrong project/currency
  and no inference of per-request cost.

A mock-network CI run is **not** a live model validation. No OpenAI
credential is configured in the existing Railway EI workers or benchmark
services. #49 final acceptance remains unchecked until real independent
charged usage, deadline/cancellation/restart and bill attribution are proven.

## Primary provider contracts

- https://developers.openai.com/api/reference/cli/resources/responses/methods/create
- https://developers.openai.com/api/reference/python/resources/responses/methods/cancel
- https://developers.openai.com/api/docs/guides/token-counting
- https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs


## Admin cost witness runner (read-only, separate from the model runner)

A separate operator context can now execute
`node scripts/validation/run-openai-admin-cost-witness.mjs` with exactly:

- `EI_CONFIRM_ADMIN_COST_WITNESS=YES`
- `OPENAI_ADMIN_KEY` — **admin-only** cost-read credential, never shared
  with the model-calling runner and never logged
- `EI_OPENAI_PROJECT_ID` — the exact **isolated validation project**
- `EI_OPENAI_COST_DAY_UTC` — one completed UTC calendar date, for example
  `2026-10-27`

The script validates an exact completed UTC day; fetches the **project-filtered
single-day** official costs using `createOpenAIProjectCostReader`; outputs
**only** a project ID digest, daily USD/micro-USD amount and explicit flags
`independentInvoiceConfirmed:false`, `perRequestAttribution:false`,
`finalBillingSettlementCertified:false`,
`remoteCancellationCertified:false` and
`isolatedProjectOperatorAttestationRequired:true`. A provider-reported
day-total is NOT a response-level invoice, nor evidence that synchronous
`fetch` abort stopped remote billing. Do not auto-join the model-call and
admin-key credentials. Keep admin output as a separate redacted evidence
record; compare to the model runner's hashed request metadata only after an
operator independently verifies project isolation, lack of other billable
activity, price-versioned input/cached/reasoning/output billing, and invoice
settlement. If this is impossible, declare **INCONCLUSIVE**, not PASS.

The new `Semantic Provider Billing Witness Conformance` pull-request CI
uses an **isolated local PostgreSQL 16** and deterministic fake network
responses only. It measures two independent pools racing one request intent,
overreported token usage and retained conservative quota, before testing
admin project-cost redaction and malformed provider outputs. Its tests and
logs MUST NOT contain `OPENAI_API_KEY` or `OPENAI_ADMIN_KEY`. A green job
is **not** the live provider/cost acceptance.

**Current actual external-evidence state (2026-10-30):** EI's
`ei-validation` Railway staging workers and validation runner do **not**
have `OPENAI_API_KEY` or `EI_CONFIRM_LIVE_OPENAI_TEST` set.
Without a separately credentialed isolated OpenAI test project, admin key
and settled project billing evidence, the last #49 acceptance cannot
be checked truthfully. A real external charge has NOT been executed,
and no invented request ID or provider invoice is used.


## 2026-10-31: actual Railway provider result and terminal-incomplete usage

The one-shot `ei-openai-semantic-once` service ran from exact EI
source commit `322427761abc2ee9880fd76767f626d80f48552f`
on private `ei-validation/staging` with real OpenAI Responses, real
staging PostgreSQL16 and a per-host one-call budget reservation.

- First deploy failed **before model invocation** because an environment
  reference did not resolve; no inference request was made by that deploy.
- Second deploy used the already-working private Muffin staging key through
  a Railway service reference. It completed the **one actual provider
  Responses request**, with an externally returned response ID,
  but returned `remote_usage_unknown`: initial response did not meet
  `status:'completed'` AND full usage shape. The provider response ID was
  logged only as SHA-256. The report retains the entire one-call
  budget reservation and **does not retry, refund or claim billing**.
  No settled token usage, per-request invoice, remote cancellation or
  independent security certification was proven in this run.

An **actual** response may be terminal `incomplete`, e.g. after reaching
`max_output_tokens`, and still contain chargeable token usage. A separate,
reviewed source change now makes the validation adapter distinguish that
case from semantic completion: only a terminal `completed` response can
claim model completion; terminal `incomplete` with valid usage requires
a **fresh provider GET** with the identical response ID, model, terminal
status, output cap and usage counters before recording usage in PostgreSQL.
The report says `incomplete_usage_observed_billing_unknown` (or
`incomplete_usage_exceeds_reservation`) and carries
`providerResponseCompleted:false`. A malformed, unrecognized or
nonterminal provider status keeps its reservation and says
`remote_usage_unknown`, with only an allowlisted status label and a
boolean reporting usage presence. Provider identifiers and text are not
exported. A malformed or disagreeing GET cannot credit a reservation.

The CLI permits only **32 or 64** `EI_OPENAI_MAX_OUTPUT_TOKENS` and still
limits a new reservation to one provider call, 128 counted input tokens,
up to 64 output tokens, and a worst-case USD 0.10 host-side budget. To try
64 tokens after a previous ambiguous provider response, operators MUST
choose **a genuinely new intent ID, batch and budget epoch** and authorize
that separate possible charge. Existing reservation never receives a
free retry. Underlying token authorization is a **host-side ceiling**,
not provider-enforced monetary billing. Tests using actual PG16 assert
terminal incomplete handling, strict GET identity/status agreement,
durable usage/semantic distinction, denied second spend across restart
and conservative refusal for nonterminal responses.

**Acceptance #49 stays unchecked** for real final billable
cost/cancellation evidence. This work closes a dangerous observation
gap, not the independent-provider invoice requirement.
