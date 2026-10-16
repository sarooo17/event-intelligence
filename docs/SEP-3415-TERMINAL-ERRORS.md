# MCP Events terminal provider errors — bounded client circuit-breaker

Part B of [#166](https://github.com/sarooo17/event-intelligence/issues/166).
Targets the **experimental** SEP-3415 reserved error codes
`-32023 NotFound` and `-32024 Forbidden`. This is not proof of
final upstream interoperability, and the upstream draft may change.

**Security boundary:** producer errors are untrusted objects. The
classifier reads only `Object.getOwnPropertyDescriptor(...).value`
for numeric `code` and nested `data.kind` on non-Proxy objects.
Only exact code numbers and the allowlisted kinds `event`,
`subscription`, `connection` are actionable. A NotFound with
connection kind is intentionally rejected; a Forbidden with any of the
allowed kinds revokes the current host connection's polling authority.
All provider text, stack, credentials, arbitrary data, causes, getters,
and prototypes are discarded, not passed to telemetry or host UI.
Malformed and transient errors remain a fixed
`MCP_EVENTS_PROVIDER_REQUEST_FAILED`, with the existing safe
public diagnostic message.

**Terminal handling:** a validated NotFound prevents further polling
of that *one* subscription on the same attached MCP connection.
A validated Forbidden prevents any subsequent poll request on
the same exact host-owned connection object, including other
subscriptions, without disabling unrelated connections.
Terminal polls return `{status:"terminal",reason:"not_found"|"forbidden",
accepted:0}` without *new* effects from the terminal response. Earlier successful pages in the same poll sweep may already have committed events, cursor checkpoints and wakes; the terminal result reports their real `accepted`, `batches`, `cursor` and `truncated` values.
No automatic unapproved action or reauthorization occurs. A host
re-attachment with a new connection object may deliberately re-probe.

**Scope/limitations:** This is an in-memory, exact-session fail-closed
circuit-breaker for the embedded client. It is *not* a persisted
revocation certificate or a replacement for host authorization or
queued wake cancellation. On full process restart the host must
revalidate the upstream session, and in-flight external effects remain
host owned. Source-delivery gaps and negative CEP finality are separate
[#166 C](https://github.com/sarooo17/event-intelligence/issues/166)
work. This PR introduces no server profile shim, legacy error codes,
database schema, published package, MCP server credentials or
Artemis/Muffin changes.

Evidence: `test/mcp-events-terminal-provider-errors.test.mjs` checks
terminal kind/code combinations, hostile Proxy/getter errors, fixed
diagnostics, no cross-subscription false suspension on NotFound,
connection-wide Forbidden suspension, and transient failure retry.

Terminal source IDs no longer selected by active triggers are pruned from
the in-memory quarantine during desired-subscription reconciliation.
Retired subscriptions are skipped in the timer's next-deadline scan,
preventing an expired historical `nextPollAt` from causing a 250ms
poll/scheduler spin; a Forbidden connection stops scheduled polling.
