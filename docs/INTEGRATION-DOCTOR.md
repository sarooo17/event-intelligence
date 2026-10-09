# Integration Doctor (offline and host contract)

Use `doctor` to catch malformed embedded integration configuration **without** invoking MCP, changing trigger state, advancing cursors, probing provider credentials, or delivering wake events.

## Offline CLI

```bash
npx mcp-event-intelligence doctor
npx mcp-event-intelligence doctor --json
```

This command validates the **local Node.js runtime** and basic fail-closed HA environment configuration. It does not open PostgreSQL, inspect the host or assert source/event readiness. Output contains PASS/WARN/FAIL checks with stable IDs and a JSON schema marker.

A `WARN` is normal: the offline CLI cannot see private host callback wiring. Even a `PASS` is **not** proof that a host can resume an agent or that a database is transactionally sound.

## Validate host callback shapes

From the embedding application:

```js
import {
  diagnoseEmbeddedConfiguration,
} from 'mcp-event-intelligence/diagnostics';

const report = diagnoseEmbeddedConfiguration({
  mcp: {
    list: () => host.mcp.listConnections(),
    subscribe: (onChange) => host.mcp.subscribe(onChange),
  },
  runtime: {
    deliver: ({ target, activation, receiptId }) =>
      host.resumeFromEvent({ target, activation, receiptId }),
    receiptNamespace: 'my-runtime',
    hasReceipt: (id) => host.receipts.has(id),
    resolveContext: (ctx) => host.eiContext(ctx),
    control: (request) => host.policy.control(request),
  },
  storeCapabilities: host.eiStoreCapabilities,
  requireSharedStore: true,
});
console.log(report);
```

**The check intentionally does not call any provided function.** It verifies API presence/shape, paired mutation controls and the declared strong shared-store capabilities. It cannot attest authority correctness, real wake delivery, durable receipts or actual database atomicity.

### Contract checks

- Host-owned source registry declares `list()` and optional `subscribe()`.
- Host continuation `deliver()` is present.
- `resolveContext()` and `control()` are supplied **together** for agent-facing tools, never with implicit authorization.
- Receipt identity uses either `receiptId()` or non-empty `receiptNamespace`; optional `hasReceipt()` lookup is reported separately.
- When shared mode is required, declared `sharedState`, `scopeIsolation`, `wakeClaims` and `partitionLeases` must meet the strong distributed-store contract.
- Invalid callback shapes fail with stable check IDs. Reports never include secret values or event payloads.

The full [host conformance suite](../conformance/README.md), multi-worker PostgreSQL tests and actual deployment approval tests remain necessary to prove real behavior.

This slice addresses [#46](https://github.com/sarooo17/event-intelligence/issues/46) partially; typed simple authoring, virtual-time simulation and production instrumentation are separately tracked.
