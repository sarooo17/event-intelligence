# Partitioned CEP — JSONL persistence/restart conformance slice

Executable acceptance: `node --test test/pattern-v2-partition-restart-oracle.test.mjs`
after `npm run build`.

The test supplies two complete business-key partitions (customers A/B), plus
one deliberately unmatched partition C. Their per-customer source order is
fixed (order before payment), but 32 deterministic seeds create different
cross-customer interleavings using LCG state
`(Math.imul(seed, 2654435761) ^ 0xa21fb329) >>> 0`, followed by
`Math.imul(1664525, state) + 1013904223` for each event. The source event
IDs and timestamps are derived from the seed and interleaving position.

For each seed, an independent finite reference model groups events by
customer and expects exactly the A and B order/payment pairs. The actual
canonical Pattern AST v2 `sequence(followedBy)` is run through the real
`CompositeTriggerEngine` and `PersistentEventStore` twice:

1. Uninterrupted delivery with a fresh store.
2. Delivery with actual `store.close()`, a new `PersistentEventStore.init()`
   and fresh trigger engine after event 2 or 3.

In both histories, matched evidence must contain only same-partition
order/payment pairs, identical source-event identities, and no extra
match involving unmatched partition C. Replaying the first source
occurrence must not append a second durable logical match. After full
delivery, a **second** physical store close/reopen must preserve the
identical match identities. The persisted audit is verified before the
second reopen. The test also requires several distinct interleavings
to avoid vacuous randomness.

**Scope boundary:** this exercises one worker, one process and the local
durable JSONL reference store. It does not prove PostgreSQL multi-worker
lease ownership, crash durability of unflushed operating-system buffers,
arbitrary nested operators, late-watermark semantics, or finality of
negative operators. A more general partition/restoration property corpus
and the release conformance report remain required before parent #44
can be closed. This test adds no DSL, store mutation logic, or
authorization authority to EI.
