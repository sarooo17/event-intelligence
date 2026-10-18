# Packed managed Node consumer proof (#42)

The executable file `docs/examples/packed-managed-consumer.mjs` is copied
into an **empty Node project** by GitHub's Clean-room Smoke workflow. The
workflow first installs a packed candidate tarball with npm and then executes
the consumer with only public `mcp-event-intelligence/embedded` imports.

The fixture tests actual runtime-neutral management actions through EI's
model-facing portable catalog, using explicit host-owned authorization and
identity, and an ordinary synthetic event source. It now also negotiates the
**versioned HostContract v1** *using only the public npm package*, requiring
MCP registry, durable state location, host-owned wake receipts and owner-scoped
mutation control. An invalid contract lacking host receipt wiring must be
rejected **before the host factory starts**; after an actual EI store restart,
the new integration must negotiate the same immutable capability report:

1. The host denies creation and proves no durable mutation occurred.
2. Each of **create/pause/resume/update/delete** runs a host-owned denial first;
   none may change persisted trigger definitions or lifecycle state. A separate
   approved call must receive the correct capability/actor/owner/target identity.
3. Host grants create/list/pause/resume with owner/actor context.
4. Events cannot deliver while paused; resume permits a durable wake/receipt.
5. The consumer closes and reopens durable EI state from a new integration,
   and reads the original authoritative wake receipt from the **reopened** store.
6. Source event replay must neither redeliver, increment persisted fireCount,
   append a logical match, nor mutate the previous receipt.
7. Update changes a trigger condition, proving old threshold no longer fires;
   the new threshold does, and delete prevents further delivery.

The Clean-room Smoke gate now asserts machine-readable report fields
`hostContractVersion: '1'`, `hostRequiredCapabilities: 4` and
`hostContractRejectedBeforeStart: true` alongside the existing mutation,
replay and receipt assertions. The `HostContract` result demonstrates only
configured host-owned capability wiring; receipt replay and mutation denial
continue to be validated by the actual runnable consumer behavior, not
inferred from the successful handshake.

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
