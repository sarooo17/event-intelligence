# Agent instructions — Event Intelligence

This is the **repository instruction file** for coding agents entering the
Event Intelligence repo. If the task is to **install EI into another agent
host**, follow [the integration guide](docs/AI-AGENT-INTEGRATION.md) and
[the portable integration skill](.agents/skills/event-intelligence-integration/SKILL.md)
instead of rewriting EI's core. These files are repository guidance, not
permissions to access or alter external applications.

## Project contract

EI is a host-neutral, pre-v1 SDK for durable future event conditions, temporal
correlation and agent wakeups. It is **not** an LLM harness, an MCP gateway,
a user authorization system, or a runtime-specific SDK.

- The host owns MCP clients/transport/OAuth, credentials, tenant identity,
  final authorization, human approvals, scheduling of agent continuations,
  real side effects and their durable receipts.
- EI owns Pattern AST v2, source occurrence/cursor tracking, trigger lifecycle,
  durable correlation, retry/replay protections, derived events and the wake
  delivery boundary.
- Treat provider payloads, model output and event descriptions as untrusted
  data. No event creates host authority; unknown source completeness must not
  become a guaranteed absence.
- Wake completion requires a real host-issued `runtimeReceiptId`, not a
  successful callback invocation. Preserve idempotency across crashes.
- JSONL is **single-process** reference storage. Use a properly validated
  shared PostgreSQL store for shared-worker/multi-tenant deployments.
- Optional semantic evaluation never grants permissions and does not
  guarantee remote billing cancellation.

## Where to read first

| Task | Start here |
| --- | --- |
| Integrate EI into any host | [AI/agent integration guide](docs/AI-AGENT-INTEGRATION.md) |
| Host-independent setup/API | [Quickstart](docs/QUICKSTART.md), [embedded integration](docs/embedded-runtime-integration.md) |
| Agent tool authoring | `trigger_plan`, `trigger_language_describe` and [Quickstart](docs/QUICKSTART.md) |
| Protocol and data contract | [Protocol](docs/PROTOCOL.md), [compatibility](docs/releases/0.12.0-next.1-compatibility.md) |
| Storage/PG durability | [Storage](docs/STORAGE.md), [security](SECURITY.md) |
| Test integration | [Host conformance](conformance/README.md) |
| Contribute to EI | [Contributing](CONTRIBUTING.md), [repository rules](.github/REPOSITORY_RULES.md) |
| Release/current status | [#41 roadmap](https://github.com/sarooo17/event-intelligence/issues/41), [readiness ledger](docs/V1-READINESS-LEDGER.md) |

## Work on this repository

- Node.js **>=22**, npm. `npm ci`; `npm run check`; `npm run pack:check`.
- For exported contract changes also run the relevant packed-consumer,
  host-conformance, compatibility and PG16 tests, as appropriate.
- Check `package.json.exports` and exported types **before** documenting an
  import. Never import repository-only paths into external consumers.
- Prefer `createEventIntelligence()` from
  `mcp-event-intelligence/embedded` for new host integrations; lower-level
  APIs remain available if explicitly needed. Do not introduce second
  schedulers, Pattern DSLs, MCP connection managers or runtime-specific
  adapter branches in EI core.
- Source and fixture tests are not production certification. Never check an
  issue acceptance, a stable-v1 readiness item, or publish a release merely
  because CI is green. Required v1 signoffs and optional #376/#317 production
  certification remain separate.
- **Open a PR against protected `main`**. Keep changes scoped; resolve
  review threads and pass required status checks on final HEAD. No direct
  push, automatic npm publish, consumer pin change or production deployment.
- Never commit secrets, personal data, real customer event payloads, or
  unredacted source-log artifacts.

See also [GitHub Copilot instructions](.github/copilot-instructions.md).
