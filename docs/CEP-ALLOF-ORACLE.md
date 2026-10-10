# Independent allOf reference oracle

Tracking [#44](https://github.com/sarooo17/event-intelligence/issues/44).
This evidence adds an **independently implemented** Cartesian pair enumerator for
a deliberately bounded `allOf(event(a), event(b))` case. It does **not** import
the Pattern interpreter or reuse its candidate merging/selection algorithm.

The deterministic suite covers 250 seeds, streams of lengths 1–9 and three
arrival permutations per seed. The seed is decorrelated before the first
LCG draw; CI asserts nonzero coverage of streams missing clause A, missing
clause B, containing both and containing neither. It compares exact event ID pair sets and ensures
no truncation. Reproducible failures identify seed, permutation, and source
clause sequence. Duplicate source IDs, unsupported clause classes and
out-of-scope corpus size are rejected by the oracle.

**Limits:** No `withinMs` window, semantic predicates, quantifiers, partition
interference, candidate budget exhaustion or complex after-match selection.
Passing this suite does not imply full CEP formal verification. Other reference
oracles separately exercise two-event sequences and negative windows.

Run after `npm run build`:

```bash
node --test test/pattern-v2-allof-oracle.test.mjs
```
