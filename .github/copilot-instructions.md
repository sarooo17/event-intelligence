# Repository-wide code review and assistant instructions

Event Intelligence is a runtime-neutral, pre-v1 event intelligence SDK.
Read [AGENTS.md](../AGENTS.md) for shared coding-agent instructions, and
[the consumer integration guide](../docs/AI-AGENT-INTEGRATION.md) when
integrating EI into a different runtime.
Follow [CONTRIBUTING.md](../CONTRIBUTING.md),
[SECURITY.md](../SECURITY.md) and
[the v1 SDK release scope](../docs/V1-SDK-RELEASE-SCOPE.md).

- Do not add a second Pattern AST, evaluator, event store, scheduler or
  runtime-specific core integration for convenience. Use the existing canonical
  APIs and documented host-owned callbacks.
- **Host authority is definitive.** No incoming event, source payload,
  semantic-model output, MCP connection or trigger can grant user permissions,
  approve an action or authorize a continuation. Untrusted evidence remains
  untrusted after hydration or summarization.
- Preserve tenant/scope separation, revocation and shared-worker epoch fencing,
  deterministic replay/dedup, stable wake IDs and real host-issued durable
  receipt IDs. Fail closed on unknown, stale, malformed or unsupported state.
- Do not conflate provider source-log completeness with local cursor progress,
  signatures with source truth, or an EI reservation ceiling with external
  provider billing/cancellation.
- New features need targeted deterministic regression tests and negative tests.
  PostgreSQL multiworker/fault claims require actual PG16 evidence.
- Performance claims require source SHA, deployment topology, raw samples,
  failure/refusal accounting and reproducible quantiles. Never turn a smoke,
  synthetic fixture, green CI or a code review into production SLO signoff.
- Exact pre-v1 API changes must include compatibility notes and stored-state
  safety. New npm versions do not silently upgrade Muffin/Artemis or other
  pinned consumers.
- Keep the nine **required** stable-v1 signoffs distinct from the **optional**
  external/enterprise evidence tracked by issue #376/#317. Do not tick an
  acceptance or mark a readiness row verified without exact supporting proof.
- Avoid secrets and private payloads in commits, CI logs and public artifacts.
  Use redacted hashes and narrow private test fixtures.

## Suggested final-HEAD verification

```sh
npm ci
npm run check
npm run pack:check
```

Use additional existing PG16/conformance/validation workflow gates for
changed behavior. Require independent final-head review before merge.
