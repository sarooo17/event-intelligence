# AI coding agent integration guide

**Audience:** coding agents and developers adding Event Intelligence to a
separate application. This is **not** a replacement for the host's own
instructions, agent lifecycle or security policy. [Repository contributor
instructions](../AGENTS.md) and
[portable integration skill](../.agents/skills/event-intelligence-integration/SKILL.md)
are separate.

## Quick decision: select one integration mode

| Goal | Supported interface | What the host still owns |
| --- | --- | --- |
| Wake an existing AI agent/workflow on future MCP events | `createEventIntelligence()` in `mcp-event-intelligence/embedded` | MCP connections, auth, continuation and durable effect receipts |
| Existing host needs fine-grained internal control | `createEmbeddedRuntimeIntegration()` or `createEventIntelligenceHost()` | Same ownership; direct store/trigger control wiring |
| An agent only needs EI management tools | `mcp-event-intelligence mcp` stdio control plane | Existing provider clients; tool exposure and confirmation authorization |
| Share durable EI state across multiple worker processes | Validated `mcp-event-intelligence/storage/postgres` implementation | PostgreSQL operations/HA, identity & ownership, backup/recovery |

**Do not create a second agent loop or a second MCP connection manager inside
EI.** If the host cannot supply a durable continuation/receipt boundary, first
implement that host-owned contract.

## 0. Inspect the target application

Before writing code, locate:

- Its existing MCP connection registry (including subscriptions/reconnect),
  and which event sources really implement the experimental MCP Events
  extension. Tools-only MCPs do **not** become future-event sources by magic.
- The actual continuation target type (job/turn/thread/checkpoint) and
  how to resume that target idempotently.
- Durable **host-issued** receipt storage, tenant/owner and revocation
  boundaries, authorization/approval control, and shutdown/restart paths.
- Single-process or shared-worker deployment and the required store.
  The default JSONL reference is **single-process**; it is not a
  multiworker database.
- The existing project's package manager, test setup, event sources,
  persisted EI data (if any) and release-pinning policy.

**Do not invent host methods:** the examples use placeholder `host.*`
calls which an agent must replace using APIs it actually found.

## 1. Install an explicitly chosen release

Node.js **>=22**. For the current pre-v1 preview described by this repo:

```sh
npm install --save-exact mcp-event-intelligence@0.12.0-next.1
```

This is an **opt-in prerelease** (`next`). Unqualified
`npm install mcp-event-intelligence` follows npm `latest`, which may
still be older. Do not automatically update an existing consumer or
migrate stored triggers. Consult
[the versioned compatibility and migration notes](releases/0.12.0-next.1-compatibility.md).
The npm dist-tags may change; verify the registry before pinning a version
in an external project.

## 2. Connect the host-neutral facade

```js
import { createEventIntelligence } from 'mcp-event-intelligence/embedded';

const ei = await createEventIntelligence({
  dataDir: './data/event-intelligence', // only the single-process reference
  mcp: {
    list: () => host.mcp.listConnections(),
    subscribe: (listener) => host.mcp.onConnectionsChanged(listener),
  },
  runtime: {
    receiptNamespace: 'my-host',
    hasReceipt: (receiptId) => host.receipts.hasPersisted(receiptId),
    deliver: async ({ activation, target, receiptId }) => {
      const receipt = await host.resumeIdempotently({
        target, activation, receiptId,
      });
      return { runtimeReceiptId: receipt.id };
    },
  },
});

// On host shutdown: await ei.close();
```

Everything called `host.*` here is deliberately a placeholder, **not**
a method exported by Event Intelligence. The host supplies real methods.
If the host has a static MCP connection iterable, see
[embedded runtime integration](embedded-runtime-integration.md).
For example, when there is no existing MCP registry EI can run in an
isolated provider adapter/test context, but do **not** describe a
tools-only MCP as supporting Events.

If EI should expose model-facing management tools, add both
`runtime.resolveContext(context)` and `runtime.control(request)`.
Return a host-owned execution decision or interrupt/approval/deny result;
never turn `control` into an implicit allow-by-default or let event
payloads grant policy.

## 3. Compile and save a real trigger

For an authenticated principal and owner **chosen by the host**:

```js
const scoped = await ei.host.scope('tenant-42');
const plan = await scoped.planTrigger({
  events: [{
    id: 'invoice',
    event: 'erpnext.sales_invoice.submitted',
    where: [{ path: 'grand_total', op: 'gt', value: 10000 }],
  }],
  withinMs: 60 * 60 * 1000,
  target: { runtime: 'my-host', kind: 'job', id: 'job-42' },
  continuation: {
    instruction: 'Review this newly submitted high-value invoice.',
  },
});

// Only after host-owned authorization/owner validation:
await scoped.triggerControl.createTrigger({
  definition: plan.definition,
  connectionIds: plan.connectionIds,
  actor: { type: 'user', principal_id: 'user-42' },
  owner: { type: 'user', principal_id: 'user-42' },
});
```

`erpnext.sales_invoice.submitted` is an **example**: it must be present
among discovered sources with a matching schema for `planTrigger()` to
succeed. Do **not** substitute a guessed server ID or a static mock in a
production claim. For complex temporal conditions, inspect
`describeTriggerLanguage({ category: 'pattern' })`, then use canonical
Pattern AST v2 instead of inventing a DSL.

For **embedded model-facing tools**, the portable `toolCatalog` exposes
`event_sources_list`, `trigger_create` and lifecycle tools;
**`trigger_plan` and `trigger_language_describe` are NOT exported as
embedded portable tools**. Either submit an agent-friendly plan to
embedded `trigger_create` (which invokes the scoped planner internally
with host-owned authorization), or call `scoped.planTrigger()` from
trusted host code as above.

For the **separate MCP stdio management control plane**, the discovery
flow is `event_sources_list` → `trigger_language_describe` (as
needed) → `trigger_plan` → **host-confirmed** `trigger_create`.
The stdio adapter is **not** a provider event gateway. Its durable
mutations are disabled by default and require explicit confirmation.

## 4. Check real delivery semantics

A callback returning successfully is **not** proof of a committed
continuation. `runtime.deliver()` must return a nonempty
`runtimeReceiptId` corresponding to a durable, host-owned result.
`runtime.hasReceipt()` should detect a previously committed delivery
after restart. Keep activation targets opaque and host-owned.

The host must enforce actor/owner/tenant isolation and revocation even
when the event source is authenticated or has a signed frontier.
Provider completeness requires an independently justified,
scope-/revision-bound completeness contract: unknown must stay unknown.

## 5. Test the integration, not only the imports

1. Verify the exact installed export(s), Node version and source readiness.
2. Trigger a real event through an existing source and confirm persisted
   trigger matching and host receipt creation.
3. Replay the same event; ensure no duplicate committed host side effect.
4. Restart the host; verify persisted wake receipt and continuation
   idempotency. Test tenant/owner isolation and revocation.
5. Run the public host conformance v3 suite through an adapter:
   [host conformance](../conformance/README.md).
6. For multi-process/PG deployment run the actual PG16 concurrency and
   recovery tests appropriate to that topology. Do not promote a JSONL
   smoke result to shared-worker production evidence.

## 6. What the coding agent must report

Finish an integration PR with the following facts, not inferred outcomes:

- Package version/pin and actual file changes.
- Existing host methods used for MCP registry, policy, target mapping,
  durable receipts and shutdown.
- Tests executed, commands and outcomes (including failures).
- Remaining issues: sources without MCP Events, lack of host-owned
  receipt durability, missing production PG16 evidence, untested billing,
  unknown provider completeness or missing independent security review.

**Do not claim** the SDK runs LLMs, manages OAuth, authenticates the host,
guarantees exactly-once external side effects, certifies production HA/SLO
or has already passed stable `1.0.0` release gates.

### Further references

- [Quickstart](QUICKSTART.md)
- [Embedded integration](embedded-runtime-integration.md)
- [Host conformance](../conformance/README.md)
- [Storage](STORAGE.md)
- [Security](../SECURITY.md)
- [Version-specific compatibility](releases/0.12.0-next.1-compatibility.md)
- [SDK readiness vs. production certification](V1-SDK-RELEASE-SCOPE.md)
