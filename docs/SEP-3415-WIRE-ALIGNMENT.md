# SEP-3415 wire-target snapshot (experimental, 2026-10-16)

Tracked under [#166](https://github.com/sarooo17/event-intelligence/issues/166), **part A**.

Target: [draft SEP-3415 PR #3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415),
head commit `c47fd24` (October 8, 2026). **Not a ratified
standard or full conformance claim**. Recheck upstream HEAD and draft
conformance [server #521](https://github.com/modelcontextprotocol/conformance/pull/521)
before releasing a new package.

The provider and the low-level experimental server return
`resultType: "complete"` for successful `events/list` and
`events/poll` JSON-RPC results. Absent and explicit-null poll cursors
mean bootstrap and normalize to `null`; a provider's **omitted result**
cursor also means `null`. A supplied cursor with another type is
`-32602 InvalidParams`, **never** coerced to string or sent to a
callback/store. Both surfaces return `-32023` with `data.kind:
"event"` for a missing event, and `-32601` for unsupported methods;
`maxEvents` remains in [1,500], with its per-page cap and
`hasMore` cursor behavior exercised by adversarial wire tests.

The draft extension's reserved error family is
`NotFound=-32023`, `Forbidden=-32024`,
`ResourceExhausted=-32025`, `Unsupported=-32026`,
`CallbackEndpointError=-32027`. These numbers are **provisional**
per the SEP. The extension ID remains
`capabilities.extensions["io.modelcontextprotocol/events"]`, not a
core `capabilities.events` alias.

**Limits/ownership:** `createMcpEventsProvider` is a poll-backed
adapter; low-level `ExperimentalMcpEventsServer` is a simple
persisted-occurrence replay reference. The host still implements and
owns actual push/Webhook endpoints, connections, authorization,
subscriber verification and deliveries. This slice does not invent
unimplemented stream/subscribe handlers and does not claim passing
external upstream suites. It intentionally removes the earlier
pre-v1 error-code wire contract (no legacy profile/shim). No npm
publication or Artemis/Muffin upgrade is performed.
