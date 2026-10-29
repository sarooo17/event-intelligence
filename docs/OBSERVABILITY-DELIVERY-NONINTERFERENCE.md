# Runtime observability neutrality — #48

This is an EI-maintained **integration regression**, not a third-party host
certification. `test/observability-runtime-equivalence.test.mjs` exercises
the actual locally embedded host with a fake MCP Events transport
(discovery, two polls, durable one-shot trigger creation, CEP matching,
wake dispatch and host receipt).

It compares **observable matching/delivery state** over four runtime
configurations: observability omitted, working minimal-default sink,
synchronously throwing sink and asynchronously rejected sink. Matching
counts, committed wake count, host receipt and lifecycle state must agree;
audit verification must pass. Sensitive provider payload and embedded
prompt-like text must not appear in the working default telemetry sink.
Failures must never suppress the wake.

The fixture makes no external requests, does not change the runtime's
audit state or production code, and does not add an SDK/logger dependency.
It is intentionally not a real host/network outage or performance
benchmark. Low-cardinality OTel projection and redaction are covered by
the earlier #92/#305 tests. This verifies **the scoped #48 acceptance
"Disabling logging/tracing never alters matching/delivery; telemetry
sink failure remains non-blocking"** once CI and independent review
confirm the current HEAD.
