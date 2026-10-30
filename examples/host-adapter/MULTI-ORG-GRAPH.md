# Reference Host B — multi-company graph/agent wake with PostgreSQL

This is an **EI-maintained executable host-boundary reference**, not an
exported EI policy engine, not the EI PostgreSQL store, and not a
third-party security certification. Implements a realistic example of
**host-owned** organization/workspace/team/user target authorization and
atomic host receipt/outbox on real PostgreSQL 16.

The reference `multi-org-graph-host.mjs` exposes:

- `initializeOrgGraphExampleSchema(pool,prefix)`: demo-only host tables.
  Real applications migrate their preexisting host authorities/outbox.
- `createOrgGraphWakeRuntime({pool,tablePrefix,orgId,workspaceId})`: a
  standard neutral EI `runtime` with `receiptNamespace`,
  `resolveTarget`, `hasReceipt`, `deliver`.
- `createOrgGraphWakeDispatcher(options)`: directly composes the public
  EI `createActivationDispatcher` to prove the host/activation boundary.
- `createOrgGraphEventIntelligence(options)`: embeds the actual canonical
  EI `createEventIntelligence` facade, allowing the host to pass an
  existing events registry and independently provisioned EI state store.

Unlike a single-agent demo, the **same** host table prefix and shared PG
pool contain multiple companies and workspaces. The runtime is constructed
with a host-trusted fixed organization/workspace, not from event
`data` or agent-generated strings. Host target resolution distinguishes
the opaque `{runtime,kind,id}` target for `agent` vs `graph` and checks
currently active `target` and `owner` membership.

The **host transaction** (not an EI function) locks both the target and
the membership authority row with `FOR UPDATE`, checks authorization
again, atomically inserts a unique receipt/outbox record, and rechecks
receipt identity on conflict. `hasReceipt` is a non-atomic precheck and
**must not** be used as a substitute for this INSERT uniqueness.
A member revoked after `resolveTarget` and before the transaction cannot
enqueue an effect. A crash after the committed insert but before the
HTTP/worker acknowledgment is reconciled by reading the host receipt
from another PG worker. A previously committed effect may already have
happened before revocation; authorization cannot retroactively undo it.

Production limits / non-goals:

- This example **does not create or restore graph/checkpoint state**. It
  hands work to the host's queue; the real graph runner owns fanout/fanin,
  session semantics and execution.
- Database membership is an intentionally small demo schema, not a
  hierarchical organization/team RBAC product or system for shared-team
  trigger discovery. A multi-team app implements its own identity/ACL and
  can expose optional model tools through the existing
  `resolveContext`/`control` bindings. Nothing here grants a user
  permissions based on `actor` from a webhook.
- Application outbox tables are NOT EI Pattern/trigger tables. Production
  EI multiworker state requires a host-provisioned real shared PG EI store
  with strict source-session fencing and appropriate worker/authority
  epochs; this example cannot turn a JSONL store into HA.
- Synthetic ActivationEnvelope v2 fixtures exercise the **real public
  dispatcher** over two independently created PG pools, with scope
  isolation, same wake/target ID in two orgs, graph and agent targets,
  receipt collisions, live membership revocation, and post-commit/
  pre-ack failure. They do **not** constitute full live third-party MCP
  producer/host SLO, transport-level external auth, or a genuine OS
  SIGKILL/recovery campaign. Those remain separate acceptance work.
- Never construct raw SQL identifiers from user input. This example
  validates its static table prefix and always parameterizes business
  identifiers. In real migrations, do not create/drop tables at runtime.

**Smoke**: `npm run test:postgres` includes
`test/postgres-host-adapter-multiorg.test.mjs` and requires PostgreSQL 16
with `POSTGRES_URL`. `npm run check` runs the file and skips these
database-specific cases when no PG is available; this is not a passing
real-DB result.

The host code must be counted in complete before/after integration cost.
There is no new EI SDK abstraction or shipping production bridge to
credit as a saved LOC. The separate headless example is covered by
PR #355. Issue #352 is only complete when cross-shape measurement,
author provenance and release-safe documentation are done.
