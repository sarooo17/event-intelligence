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
