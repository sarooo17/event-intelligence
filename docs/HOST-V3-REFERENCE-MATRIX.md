# Packed managed Node consumer proof (#42)

The executable file `docs/examples/packed-managed-consumer.mjs` is copied
into an **empty Node project** by GitHub's Clean-room Smoke workflow. The
workflow first installs a packed candidate tarball with npm and then executes
the consumer with only public `mcp-event-intelligence/embedded` imports.

The fixture tests actual runtime-neutral management actions through EI's
model-facing portable catalog, using explicit host-owned authorization and
identity, and an ordinary synthetic event source:

1. The host denies creation and proves no durable mutation occurred.
2. Host grants create/list/pause/resume with owner/actor context.
3. Events cannot deliver while paused; resume permits a durable wake/receipt.
4. The consumer closes and reopens the durable state from a new EI integration.
5. Source event replay must not redeliver the existing wake.
6. Update changes a trigger condition, proving old threshold no longer fires;
   the new threshold does, and a subsequent delete prevents further delivery.

The code uses **no EI repository relative import, model SDK, provider secrets
or network transport**, and emits machine-readable
`event-intelligence.packed-managed-consumer.v1`. CI asserts the real
report fields rather than treating example compilation as a conformance pass.

**Limitations:** The consumer fixture was authored inside this repository
and merely executed in a different filesystem. It is **not an independently
authored third-party runtime** and is not counted toward that #42 gate. The
fixture tests a synthetic source and local durable store; it does not certify
live MCP network transport, cross-worker PostgreSQL failover, host-side
external checkpoint durability beyond the explicit in-memory receipts,
or exactly-once external notifications. These remain separate readiness
conditions. No Artemis/Muffin files are changed or upgraded.
