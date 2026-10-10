# Shared operation manifest — phase 1

Tracking [#43](https://github.com/sarooo17/event-intelligence/issues/43).

`scripts/lib/operation-manifest.mjs` is the **shared source of truth** for
tool names, stable capability IDs, read/mutation classification, durability,
host-control requirement, declared scope class and surface exposure.

- The embedded facade's eight operation descriptors use names and
  authorization/effect metadata from this manifest, while keeping their
  existing host-neutral JSON argument schemas.
- All 14 standalone MCP tool registrations use the same canonical names.
  In read-only mode, the standalone MCP service exposes nine non-mutating
  tools. The remaining five durable operations require the operator's
  `MCP_WRITE_ENABLED=true`, and still require confirmation provenance
  at execution.
- The `operationNamesForSurface(surface, {allowMutations})` query is
  **metadata**, not runtime authorization or an SDK adapter.
- The tests check 14 distinct IDs/names, metadata invariants, actual
  read/write MCP stdio discovery, and the 8 embedded registry descriptors.

The manifest is intentionally not a second Pattern AST language or an
agent tool loop. It does not publish provider credentials, source metadata
or tenant data, and it does **not** bypass the host's scoped policy engine.

**Not yet unified:** embedded and stdio management argument schemas are
different public projections (`trigger_id` vs `triggerId`, compact
authoring vs `trigger_plan`). This first PR does **not** falsely declare
those schemas or output envelopes interchangeable. The remaining #43 work
includes canonical input/output schema contracts, validated projections,
risk/owner claims by operation and conformance with the service/CLI.
Operators should not infer `scope` is itself a permission check.
