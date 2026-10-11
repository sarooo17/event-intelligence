# Pattern AST v2 — bounded semantic conformance map

This is the public *tested subset* of the single canonical Pattern AST v2.
It is **not** a complete formal proof of every operator and combination.
The source evaluator never gains runtime credentials or a second agent loop.

| Operator / contract | Expected observable semantics | Reproducible evidence |
| --- | --- | --- |
| `event` | An owned occurrence binds its declared reference only | `test/pattern-v2.test.mjs` |
| `allOf(a,b)` | Every eligible a/b pair (Cartesian within bounded corpus) | `test/pattern-v2-allof-oracle.test.mjs`; 250 seeds × 3 shuffles |
| `anyOf(a,b)` | Each eligible a or b occurrence matches, unrelated noise does not | `test/pattern-v2-anyof-oracle.test.mjs`; 250 seeds × 3 shuffles |
| `sequence(next)` | Only an immediately adjacent a→b ordered pair | `test/pattern-v2-oracle.test.mjs`; 250 seeds × 3 shuffles |
| `sequence(followedBy)` | First later b per qualifying a under this bounded oracle subset | `test/pattern-v2-oracle.test.mjs`; 250 seeds × 3 shuffles |
| `notFollowedBy` | Forbidden b strictly after anchor and up to inclusive deadline prevents match; fire only when deadline + lateness is reached | `test/pattern-v2-negation-oracle.test.mjs`; 250 seeds × arrivals × clock boundaries |
| Execution budgets | Report explicit truncation rather than silent complete/no-match claim | `scripts/evidence/pattern-v2-conformance.mjs` |
| Semantic evaluation | Runs only when explicitly configured and respects bounded call count | `test/pattern-v2-semantic-cache.test.mjs`, `test/semantic-scope-budget-conformance.test.mjs` |

## Oracle boundaries and replay recipe

All independent reference modules under `scripts/evidence/reference-*-oracle.mjs`
enumerate finite source data using their own simple logic, **without calling
the evaluator's candidate merger or selection helpers**. Each reference
states the exact supported domain (event references, overlap, partitions,
lateness, and bounds). The tests fail closed if asked to pretend support for
unmodeled semantics.

Execute against Node >=22:

```sh
npm ci
npm run build
node --test test/pattern-v2-oracle.test.mjs \
  test/pattern-v2-allof-oracle.test.mjs \
  test/pattern-v2-anyof-oracle.test.mjs \
  test/pattern-v2-negation-oracle.test.mjs
npm run conformance:pattern-v2
```

Reproduction inputs:
- `anyOf` and `allOf`: integer seeds **1–250**, bounded 1–9
  occurrences, 3 arrival permutations, `LCG(1664525,1013904223)`,
  seed scrambling via `Math.imul(seed, 2654435761)` and explicit XOR
  constants in each test. Each generated event ID embeds its seed/index;
  timestamps derive from UTC `2026-10-01T12:00:00Z`.
- `sequence`: integer seeds 1–250; 1–8 bounded events, 3 permutations,
  UTC synthetic event ordering.
- `notFollowedBy`: integer seeds 1–250; bounded event/arrival/window
  clock oracle, including the exact allowed-lateness threshold.
- All test failures name the seed, round and source-branch sequence;
  the source file is the generator and fixture specification.
- Mutation sensitivity: `anyOf` tests deliberately inject three
  incorrect expected outcomes (drop b, admit noise, collapse duplicates)
  and assert that the independent oracle detects all of them. This is
  **not** mutation-testing the production evaluator executable itself.

## Unproven combinations

The above does **not** fully cover `repeat`, nested `optional`,
`notNext`, `notPresent`, `notUntil`, arbitrary `followedByAny`,
high-cardinality partitions, mixed derived event chains, semantic timeout
chaos or persistent multi-worker restarts. Those require separate
differential/property suites and operational evidence before closing #44.
A pattern budget truncation is **inconclusive**, never evidence of absence.

Breaking Pattern AST semantics require an explicit documented version/migration
decision, not a silent reinterpretation of persisted triggers.
