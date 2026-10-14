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
| `notPresent(ref=b, child=allOf(a,c))` | For each Cartesian (a,c) pair, reject only when a b lies inside that pair's inclusive chronological span; outside b and unrelated noise do not veto | `test/pattern-v2-nested-notpresent-oracle.test.mjs`; 250 seeds × 3 arrival permutations, boundary/mutation probes |
| `notNext(event(a),event(b))` | On one finite unpartitioned snapshot, an a survives unless the immediately following event-time occurrence (including noise) is b; a at the tail survives **only as a snapshot result**, not a finalized negative claim | `test/pattern-v2-notnext-oracle.test.mjs`; 250 seeds × 3 arrival permutations + boundary and mutation probes |
| `notFollowedBy` | Forbidden b strictly after anchor and up to inclusive deadline prevents match; fire only when deadline + lateness is reached | `test/pattern-v2-negation-oracle.test.mjs`; 250 seeds × arrivals × clock boundaries |
| `repeat(event(x))` | For `min:1..3`, `max: min..3`, enumerate valid source subsets; `combinations` allows gaps, `relaxed` skips only unrelated noise, `consecutive` requires adjacent source positions; both `greedy` and `lazy` produce the same untruncated match **set** | `test/pattern-v2-repeat-oracle.test.mjs`; 250 seeds × 3 shuffles × 2 modes × 18 exhaustive min/max/contiguity configurations |
| Execution budgets and interpretation | A bounded intermediate candidate branch can lose a real match yet return zero matches; `truncated:true` means **inconclusive**, not no-match. Temporal pending and capped semantic calls have distinct evidence | `test/pattern-v2-budget-evidence.test.mjs`; `scripts/evidence/pattern-v2-budget-evidence.mjs` |
| Candidate and semantic budgets | Budget exhaustion sets `truncated:true` even when `matches:[]`; only an untruncated empty result is a conclusive no-match within the modeled bounded snapshot | `test/pattern-v2-budget-outcomes.test.mjs`, `scripts/evidence/pattern-v2-conformance.mjs` |
| Semantic evaluation | Runs only when explicitly configured and respects bounded call count | `test/pattern-v2-semantic-cache.test.mjs`, `test/semantic-scope-budget-conformance.test.mjs` |

## Conformance report v3 and evidence integrity

Run `npm run conformance:pattern-v2` for a JSON report tagged
`event-intelligence.pattern-conformance.v3`. This npm command first deletes
stale `dist` output and performs a fresh TypeScript build. The evidence
script then checks the original compiled tree, copies it into a private
per-run snapshot beneath the repository, attests the snapshot, dynamically
imports the evaluator **from the snapshot** and checks that the snapshot's
compiled hash did not change after evaluation. The private copy is removed
in `finally`. The attestation helper is also copied into this private
snapshot, dynamically imported from those exact bytes, and rehashed after
execution: its reported digest cannot silently describe a different
working-tree revision. A concurrent modification of the working `dist` tree
therefore cannot silently change the evaluated bytes after import; tampering
with the private snapshot causes a failed report if its final digest differs.
Invoking the evidence script directly does not clean or rebuild the workspace. The report includes package
version, canonical AST version, Node/OS/platform/architecture, optional CI
Git commit, harness-file SHA-256 (rechecked before emission), the imported attestation-helper SHA-256, entrypoint module hashes, a
**deterministic SHA-256 over every compiled `dist/src/**/*.js` runtime
module** (including transitively imported modules), and a SHA-256 of
`package-lock.json` for dependency version commitments; seed range,
source fixture SHA-256 for each case, execution budgets, run counts and
*explicit* complete, pending-temporal-finality and budget-inconclusive
totals. A candidate with an unexpired negative window is `pending`, never
`complete`; `inconclusive` specifically denotes budget truncation. The runtime build tree is
sorted by relative path before hashing `[{path,sha256}]`; the report tests
independently recompute that digest. Any symlink beneath the explicitly trusted repository/build root, including
`dist` and nested compiled modules, **rejects attestation** instead of being
skipped. Known benign OS/workspace symlinks **above** that trusted boundary
(such as macOS `/var`) are outside the check. The private snapshot is
attested under its own temporary trusted root.
An isolated regression constructs symlinked runtime fixtures and verifies
these cases fail closed. On local worktrees where GitHub SHA is
absent this still binds the report to the **actual compiled** code and
dependency lockfile, regardless of unchanged npm version, but it is not
proof that `dist` matches checked-in sources or that an installed
`node_modules` tree is untampered. The source input commitment now hashes an ordered list of **per-evaluation**
SHA-256 values, each over the exact synthetic `{definition,events,now,
allowedLatenessMs,evaluatorFixture}` passed to the canonical evaluator
(`now` defaults to a fixed replay clock for deterministic cases). The
report archives only the per-run hashes and their aggregate digest, not
private event payloads. In particular, the pending negative-window run and
the forbidden-event run retain distinct source/clock/lateness commitments.
The script itself defines these synthetic inputs and the replay command,
without writing raw payloads or credentials to the report. It does not claim a passing release-gate result
on a failure: assertion errors terminate the command nonzero.

The `candidate budget` witness constructs a true next-adjacent match after
two earlier candidates. A two-candidate first-stage limit yields
`matches:[]` **and** `truncated:true`; a larger limit finds the source
pair, and a complete unmatched snapshot has `truncated:false`. Tests repeat
this with 100 deterministic arrival seeds and an independent chronological
adjacency model. The semantic evaluator's zero-call budget also yields an
inconclusive zero-match result, while an allowed call resolves a match;
malformed budget definitions fail at schema validation. This tests outcome
distinctions, not all possible candidate explosions, irreversible negative
finality, runtime scheduling decisions, or high-cardinality persistence.

Report hashes identify *synthetic fixtures*, not every intermediate
permutation or an immutable archived artifact. The full independent oracle
suite is executed separately with the commands below and remains bounded.
CI run logs and the Git commit identify the specific report execution;
the report does not attest real hardware performance or certify #44's
unproven combinations. No user-provided event payload belongs in the report.

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
  test/pattern-v2-budget-outcomes.test.mjs \
  test/pattern-v2-evidence-report.test.mjs \
  test/pattern-v2-notnext-oracle.test.mjs \
  test/pattern-v2-nested-notpresent-oracle.test.mjs \
  test/pattern-v2-negation-oracle.test.mjs \
  test/pattern-v2-repeat-oracle.test.mjs
npm run conformance:pattern-v2
npm run evidence:pattern-v2  # uses the same clean-build conformance gate before benchmarking
npm run conformance:pattern-v2-budget
```

Reproduction inputs:
- `anyOf` and `allOf`: integer seeds **1–250**, bounded 1–9
  occurrences, 3 arrival permutations, `LCG(1664525,1013904223)`,
  seed scrambling via `Math.imul(seed, 2654435761)` and explicit XOR
  constants in each test. Each generated event ID embeds its seed/index;
  timestamps derive from UTC `2026-10-01T12:00:00Z`.
- `sequence`: integer seeds 1–250; 1–8 bounded events, 3 permutations,
  UTC synthetic event ordering.
- Nested `notPresent` with two-branch `allOf`: integer seeds 1–250,
  1–9 unique event-time occurrences, 3 arrival permutations, reverse-lexical
  IDs, independent Cartesian pair-and-range enumeration. Tests prove a b
  inside a selected pair vetoes **only that pair**, while b outside and
  unrelated noise remain allowed. Unsupported timestamps, equal-time ties,
  duplicate IDs and unsupported refs fail closed. This is finite-snapshot,
  unpartitioned evidence, **not** negative event finality, arbitrary nested
  AST depth, or completeness under budget truncation.
- `notNext`: integer seeds 1–250, 1–10 events (including reverse-lexical IDs),
  3 arrival shuffles, independent timestamp-sorted finite oracle, tested
  adjacent b vs intervening noise vs final a, mutation probes, fail-closed
  duplicate-ID / equal-timestamp / offset-free timestamp domain rejection.
  This is NOT a stream-finality or pending-watermark specification: terminal
  a is returned in finite-snapshot evaluation and can be invalidated by a
  future b in a real streaming system. Do not use a snapshot no-b result
  as an irreversible external action without host-level completion semantics.
- `notFollowedBy`: integer seeds 1–250; bounded event/arrival/window
  clock oracle, including the exact allowed-lateness threshold.
- `repeat`: integer seeds **1–250**, stream length 1–9, up to three `x`
  repetitions per candidate, every one of the six min/max pairs across all
  three contiguity variants, 3 arrival permutations, and 2 preference modes;
  seeded LCG `Math.imul(seed, 2654435761) ^ 0x51bca607` assigns each
  event `x` or unrelated `noise`. UTC origin is `2026-10-02T12:00:00Z`.
  IDs use a **reverse lexicographic suffix** relative to monotonically increasing
  timestamps, so accidental ID-sorting cannot masquerade as event-time order.
  The independent oracle exhaustively enumerates subsets of the `x` events
  under three contiguity variants, without invoking evaluator helpers.
  Differential tests verify complete candidate bindings and the **exact
  chronological order** of `candidate.events` provenance; incorrect ordering,
  stray noise or duplicate source events fail the test.
- All test failures name the seed, round and source-branch sequence;
  the source file is the generator and fixture specification.
- Mutation sensitivity: `anyOf` tests deliberately inject three
  incorrect expected outcomes (drop b, admit noise, collapse duplicates)
  and assert that the independent oracle detects all of them. This is
  **not** mutation-testing the production evaluator executable itself.

## Unproven combinations

The above does **not** cover unbounded or nested `repeat`, zero-minimum
`repeat`, nested `optional`,
arbitrary nested `notPresent`/`notUntil`, arbitrary `followedByAny`,
high-cardinality partitions, mixed derived event chains, semantic timeout
chaos or persistent multi-worker restarts. Those require separate
differential/property suites and operational evidence before closing #44.
The bounded repeat oracle asserts match membership, **not greedy/lazy result
ordering** or production runtime restart guarantees.
A pattern budget truncation is **inconclusive**, never evidence of absence.

Breaking Pattern AST semantics require an explicit documented version/migration
decision, not a silent reinterpretation of persisted triggers.

## Reproducible budget/no-match evidence (2026-10-14)

`npm run conformance:pattern-v2-budget` emits
`event-intelligence.cep-budget-evidence.v1` JSON on stdout. To retain
a copy, use `node scripts/evidence/pattern-v2-budget-evidence.mjs --out
cep-budget-evidence.json` after building. CI uploads the same JSON as a
machine-readable `cep-budget-evidence` artifact. The report records:

- package version, Node version, OS platform/architecture, and the optional
  `GITHUB_SHA` commit identity available in CI;
- deterministic seed **20261014**, fixed UTC clock, each synthetic source
  occurrence's ID/ref/timestamp, and stable SHA-256 hashes of the complete
  synthetic source fixture and canonical Pattern definition (the report
  includes the complete synthetic source objects so both hashes can be
  independently recomputed; never use this fixture dumper for live private
  event payloads);
- configured candidate/semantic/buffer budgets, lateness, and raw
  `truncated`, matches, pending, and semantic evaluation counts.

A diagnostic-only interpretation is derived from the canonical evaluator's
result with the following precedence: `incomplete_budget` if
`truncated=true`; otherwise `awaiting_temporal_finality` if there are
pending candidates; otherwise `matched` if any matches exist; otherwise
`complete_no_match`. This is **not a second evaluator**, a new public
runtime API or an authorization decision. In particular, a negative window
pending completion must not be reported as definitely absent.

The adversarial fixture evaluates the **same event corpus** with both
`maxCandidates=1` and `maxCandidates=32`. The smaller budget truncates an
intermediate `anyOf` branch and returns **no** matches; the larger budget
finds the adjacent `b→c` match. The test detects this distinction, also
proves an actually complete no-match, checks pending negative finality,
and confirms that a semantic evaluator with a one-call budget stops
with explicit truncation.

**Limits:** These are deterministic bounded synthetic **snapshot**
examples, not a proof that arbitrary Pattern ASTs preserve all valid
matches when truncated. Incomplete results cannot justify a negative
conclusion or external side effect. The report does not establish
partition independence, OS-process restart equivalence, clock/DST
exhaustiveness, semantic timeouts, unbounded nested patterns, or
production workload limits. Those remain open in #44.
