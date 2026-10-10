# Negative event-time oracle — independent bounded conformance

Tracking [#44](https://github.com/sarooo17/event-intelligence/issues/44).

This test models **the simple** Pattern AST v2 `notFollowedBy(event a, event b, withinMs)` subset using an independent enumerator. The oracle checks every `a` anchor against future `b` events, including a `b` exactly at the deadline. For an unblocked anchor it independently computes the transition from pending to eligible when `now >= anchor + withinMs + allowedLatenessMs`.

```bash
npm run build
node --test test/pattern-v2-negation-oracle.test.mjs
```

The suite compares 250 fixed seeds, varying stream lengths from 1–10, three shuffled arrival orders and three deterministic wall-clock positions per seed. It additionally checks both ends of the forbidden interval: an event at the **same instant as the anchor does not block**; an event exactly on the future deadline blocks, while deadline +1 ms does not. Unblocked matches remain pending at **finalAt−1 ms** and become eligible at **finalAt**. Invalid timing parameters are rejected.

**Scope exclusions:** This is NOT a formal proof for all CEP, nor a streaming-watermark recovery oracle. It excludes partitioning, nested forbidden patterns, timer persistence, real MCP delivery, probabilistic semantics and crash/restart. Even with passing results, negative conditions must be verified with real event-source cursors and persistent deadline recovery. Extend #44 with those separately.

Both engines receive the *same* event-time record set and `now`. Arrival shuffling tests order invariance, but is not a substitute for end-to-end out-of-order ingress replay.
