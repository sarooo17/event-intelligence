# Host conformance

Event Intelligence ships two separate conformance layers.

## Runtime contract conformance

The existing fixtures and regression suite validate EI's own protocol, Pattern,
storage, audit and MCP Events boundaries.

A conforming EI adapter must preserve canonical schemas, stable event identity,
source evidence, lifecycle correctness, replay deduplication, hash-linked audit
history and the rule that external event data is evidence rather than
authorization.

Run the full internal suite with:

```bash
npm run check
```

## Embedded host conformance

The public `mcp-event-intelligence/conformance` entry point validates an
embedding runtime without teaching EI about that runtime.

Implement `createHarness({ observability })` and return seven operations (host conformance v3):

- `createTrigger()`
- `emitEvent()`
- `deliveries()`
- `restart()`
- `inspectTrigger()`
- `readWakeReceipt(wakeId)` (authoritative persisted status and runtime receipt)
- `close()`

Then run:

```js
import { runHostConformance } from 'mcp-event-intelligence/conformance';

const report = await runHostConformance(myRuntimeAdapter, {
  throwOnFailure: true,
});
```

Core v3 checks cover one-shot delivery, replay deduplication, restart
persistence, post-delivery replay and a **durable receipt read after reopening**
the host, fresh-event continuity, bounded `maxFirings`, and required structured observability
(`ei.trigger.created`, `ei.match.matched`, `ei.wake.delivered`).

The scenarios are intentionally isolated and synthetic. Do not point the
conformance harness at production continuations or production event sources.

The repository reference adapter can be run with:

```bash
npm run conformance:host
```

The MCP Events draft remains upstream and experimental. These checks certify
Event Intelligence host behavior, not official MCP conformance.

**Breaking pre-v1 conformance contract:** reports use
`event-intelligence.host-conformance.v3`. Adapter delivery rows must supply
both `wakeId` and `runtimeReceiptId`, and `readWakeReceipt(wakeId)` must read
from the restored authoritative EI store, not a process-local delivery list.
Older v2 adapters must deliberately upgrade; EI does not provide a compatibility
shim. A restored delivery observer may start empty or contain exactly one
completed prior wake identity; duplicates observed during restart fail the
suite. An observer that **resets** and then silently redelivers the *same*
identity once is indistinguishable without independent host effect accounting:
the host must independently enforce receipt idempotency. This test verifies EI
receipt persistence, not external runtime checkpoint persistence, distributed
exactly-once effects or true OS process-kill recovery.

## True OS-process restart evidence (reference fixture)

`node --test test/process-host-conformance.test.mjs` runs the complete
seven-case management v3 suite against an **EI reference host in a child
process**. The parent does not import EI's runtime engine: calls cross IPC,
while the child's host uses the existing real EI store, planner, matching
engine and wake coordinator. During `restart()` the child is killed with
`SIGKILL` without running host `close()`; a new PID opens the same durable
state directory. Parent-side delivery observations outlive the child, but
`readWakeReceipt` always queries the new child's authoritative EI store.

A separate mutation test suppresses restored receipt lookup **inside
the restarted worker process**, and requires the
`core.restart-after-delivery-replay` scenario to fail. The worker evaluates
the observability leak canary on full local events before sending only an
event name and leak verdict over IPC; another negative control confirms
this leak fails conformance. A timed-out RPC kills and invalidates its worker
to prevent late writes racing later scenarios. Each subprocess and temp
directory is explicitly cleaned up after the suite, with finite
startup/RPC/exit timeouts.

**Scope:** this is a *locally authored reference host*, not independently
authored third-party host adoption. It proves process-boundary receipt
durability and v3 management functionality on the selected fixture, not
multi-worker PostgreSQL HA, production crash consistency for all storage
engines, notification exactly-once side effects, registry reconnect across
processes or the required three distinct host implementations. These
remaining acceptance criteria are tracked by #42.


## MCP registry detach/reattach across a hard restart

The dedicated `node --test test/host-registry-process-restart.test.mjs`
fixture uses the actual `createEventIntelligenceHost()` and a host-owned
MCP Events mock provider in a **separate OS process**. Its parent controls
registry availability over bounded IPC and retains no EI store or client.
The test attaches an Events connection, registers a durable trigger, ingests
and delivers an occurrence, detaches the registry entry (disabling its
persisted source), and SIGKILLs the process. A new PID reopens the same
persistent store while disconnected, then a fresh MCP session reattaches
under the original connection ID. Replaying the same occurrence must
not deliver a second wake; a new event must progress the original trigger.
A second SIGKILL confirms both receipts remain authoritative, and a
manual host connection under the same ID cannot be adopted by a
subsequent registry refresh.

This is locally authored integration conformance against a mock MCP Events
producer. It does **not** prove third-party adoption, real network
reconnect, multi-worker PostgreSQL failover, or exactly-once external
continuation effects. The host still owns MCP transport/auth/session,
notifications and mutation policy. Remaining #42 criteria are unchanged.
