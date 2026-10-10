# Pattern AST v2: independent bounded sequence oracle

Tracking [#44](https://github.com/sarooo17/event-intelligence/issues/44).

The implementation is **not** the specification. The new `reference-sequence-oracle.mjs` is a deliberately separate, small enumerator for event-time ordered **two-clause sequences**. It never imports or calls the Pattern evaluator; it independently computes eligible pairs by examining the chronological stream.

## Supported subset

- Distinct source occurrences with unique event timestamps.
- Two clause references (`a`, `b`), unrelated `noise` occurrences.
- `sequence(next)`: the immediate following event must be `b`.
- `sequence(followedBy)`: the first subsequent `b` for each `a`.
- `overlap: allow`, `afterMatch: keepAll`; no candidate budget exhaustion.

This does **not** prove other operators, event-time tie-breaks, partitions, late watermark replay, cross-worker persistence or semantic evaluator behavior.

## Test

```sh
npm run build
node --test test/pattern-v2-oracle.test.mjs
```

The suite compares each mode with 250 seeded pseudo-random event streams (up to eight records), and three delivery order permutations per stream. Failure prints the seed, contiguity, round and clause sequence to reproduce the discrepancy. Randomness is deterministic and is not a source of nondeterminism in CI.

The test intentionally rejects an unsupported oracle operation rather than silently pretending to verify another Pattern AST semantics.

## Next scope for #44

- Independent bounded negative-window and watermark oracle with deadline precision.
- Differential aggregate, distinct, rate, repeat, partitioning and candidate truncation.
- Property mutation injection and minimized counterexample corpus.
- Restart/replay equivalence at the actual persisted/runtime boundary.
- Full conformance evidence with run artifacts and explicit operator coverage.

A green check demonstrates only the named subset. It is **not** certification that the whole CEP engine is formally verified.
