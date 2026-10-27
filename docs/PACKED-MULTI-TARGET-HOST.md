# Packed multi-target host fixture — EI #272

`docs/examples/packed-multi-target-host.mjs` is a **real packed-package**
consumer of the public `mcp-event-intelligence/embedded` API, executed in an
empty project in GitHub Clean-room Smoke. It imports **no source-private paths**
and no host SDK, LLM framework, sessions, chat, or prompts.

The host owns three unrelated continuation shapes: an agent run, graph
checkpoint and batch job, spanning two authoritative tenant scopes. Its
`receiptId`, `resolveTarget`, `deliver`, scope lookup and revocation are
all **host callbacks**, using `createActivationDispatcher`. The same wake ID
across independent scopes produces distinct receipt IDs. A replay returns
duplicate without scheduling a second host effect. Host metadata checks
reject inactive targets and inconsistent target kinds. External evidence
remains explicitly untrusted; no implicit owner authority is created.

## What this does NOT establish

- The fixture is authored and maintained within EI. It is **not independently
  authored third-party adoption** and cannot close #42's external criterion.
- The in-memory receipt set is intentionally **not durable or atomic**. It
  demonstrates target shape and scope handling only. Two parallel processes
  can still race; use #276's separately tested real PostgreSQL transaction
  example for a host-owned atomic queue/receipt.
- It does not measure model throughput, production SLO, network partitions,
  auth provider behavior or arbitrary external SDK compatibility.

## Adapter-cost measurement

The current real Muffin candidate adapter remains **392 physical / 361
nonblank LOC**, down from baseline 398 / 365; this fixture does NOT claim to
reduce it. The original #274 wrapper experiment was closed without merge
because it only relocated descriptor glue. Host-specific principal,
authorization, result taint, session, tool ABI, workflow state and durable
host effects must remain with each consumer. #272 will need a *different,
independently implemented* external host and a full net-code comparison
before any general-purpose adapter-LOC reduction claim can be accepted.
