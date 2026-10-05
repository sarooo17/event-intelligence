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

Implement `createHarness({ observability })` and return six operations:

- `createTrigger()`
- `emitEvent()`
- `deliveries()`
- `restart()`
- `inspectTrigger()`
- `close()`

Then run:

```js
import { runHostConformance } from 'mcp-event-intelligence/conformance';

const report = await runHostConformance(myRuntimeAdapter, {
  throwOnFailure: true,
});
```

Core v1 checks cover one-shot delivery, replay deduplication, restart
persistence, bounded `maxFirings`, and required structured observability
(`ei.trigger.created`, `ei.match.matched`, `ei.wake.delivered`).

The scenarios are intentionally isolated and synthetic. Do not point the
conformance harness at production continuations or production event sources.

The repository reference adapter can be run with:

```bash
npm run conformance:host
```

The MCP Events draft remains upstream and experimental. These checks certify
Event Intelligence host behavior, not official MCP conformance.
