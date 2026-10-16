# SEP-3415 client poll safety (part B, first slice)

Tracking [#166](https://github.com/sarooo17/event-intelligence/issues/166).
Experimental draft [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415)
at upstream commit `c47fd24`, not a released protocol mandate.

The **host-owned** MCP client connection can set `pollFloorMs` (integer
1,000–300,000; default `1,000`). If `hasMore:false`, the requested next
poll is `max(pollFloorMs, provider.nextPollMs)`; a provider's zero is
not permission for an unbounded tight retry loop. A larger producer
backoff is respected. `respectSchedule:true` honors durable
`nextPollAt`, including after manager restart; the timer avoids
unnecessary subsecond wakes before future deadlines.

If `hasMore:true`, EI immediately drains available pages within one
bounded invocation: `maxPollBatches` remains 1–32 and `maxEvents` is
capped on **every** page. A producer asserting backlog without a usable
continuation cursor is rejected before ingest or cursor checkpoint.
Across cycles, the existing scheduler can resume a backlog after a
short bounded timer; there is no always-running agent loop.

On `events/poll` results, explicit-null **or omitted** cursor is
interpreted as `null`. A poll producer that cannot support replay may
return no cursor, but cannot claim an addressable `hasMore` backlog
without one. Host-owned push/webhook callback omission is different:
it preserves the previous cursor, as detailed below.

Evidence: `test/mcp-events-sep3415-poll-floor.test.mjs` and existing
`test/mcp-polling-backpressure.test.mjs`. Reproducible fixtures cover
producer zero and larger backoff, configurable floor, omitted cursors,
pagination bursts, invalid configurations and durable checkpoint.

**Not covered in this slice:** provider error-code terminal
classification (to follow in a separate #166 B PR), gap propagation to
negative CEP finality (#166 C), native host-owned stream/webhook
transport renewal or future SEP changes. No EI runtime polling
delegation to the agent, no npm publish and no Muffin/Artemis changes.

### Cursor omission in host-owned push/webhook callbacks

Unlike `events/poll` responses, absence of a `cursor` **field** from
`onEvent`, `onActive`, or the returned delivery handle **preserves
previous persisted cursor state**. It represents an event/heartbeat that
does not advance or reset the durable cursor, not an explicit rebootstrap.
An **explicit `cursor:null`** resets the retained cursor to null.
This distinction avoids silently erasing a valid cursor when a push event
includes no cursor metadata. Host adapters needing reset MUST send an
explicit null. This is an intentional adapter boundary semantic; the
draft MCP Events poll response omitted-cursor rule remains null.
