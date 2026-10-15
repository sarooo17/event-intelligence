# Pattern AST v2 — bounded semantic conformance map

This is the public *tested subset* of the single canonical Pattern AST v2.
It is **not** a complete formal proof of every operator and combination.
The source evaluator never gains runtime credentials or a second agent loop.

| Operator / contract | Expected observable semantics | Reproducible evidence |
| --- | --- | --- |
| `event` | An owned occurrence binds its declared reference only | `test/pattern-v2.test.mjs` |
| `allOf(a,b)` | Every eligible a/b pair (Cartesian within bounded corpus) | `test/pattern-v2-allof-oracle.test.mjs`; 250 seeds × 3 shuffles |
| `window(allOf(a,b))` | All Cartesian a/b candidates that satisfy an independent bounded window test: within, sliding, tumbling, hopping, session or count; chronological position is independent of lexical source IDs | `test/pattern-v2-window-allof-oracle.test.mjs`; 100 seeds × 3 delivery permutations × 6 window variants, inclusive-boundary/mutation probes |
| `anyOf(a,b)` | Each eligible a or b occurrence matches, unrelated noise does not | `test/pattern-v2-anyof-oracle.test.mjs`; 250 seeds × 3 shuffles |
| `sequence(next)` | Only an immediately adjacent a→b ordered pair | `test/pattern-v2-oracle.test.mjs`; 250 seeds × 3 shuffles |
| Equal event-time ordering and extreme ISO dates | Stable tie-breaking by source ID and then clause ref at identical absolute event instants, independent of delivery order; distinguish distinct physical sources even when IDs coincide across servers | `test/pattern-v2-equal-time-ordering-oracle.test.mjs`; 96 seeded tied streams × 3 arrival permutations, clause fallback, explicit offset-equivalence and years 0001/9999 |
| `sequence(followedBy)` | First later b per qualifying a under this bounded oracle subset | `test/pattern-v2-oracle.test.mjs`; 250 seeds × 3 shuffles |
| `notPresent(ref=b, child=allOf(a,c))` | For each Cartesian (a,c) pair, reject only when a b lies inside that pair's inclusive chronological span; outside b and unrelated noise do not veto | `test/pattern-v2-nested-notpresent-oracle.test.mjs`; 250 seeds × 3 arrival permutations, boundary/mutation probes |
| `notNext(event(a),event(b))` | On one finite unpartitioned snapshot, an a survives unless the immediately following event-time occurrence (including noise) is b; a at the tail survives **only as a snapshot result**, not a finalized negative claim | `test/pattern-v2-notnext-oracle.test.mjs`; 250 seeds × 3 arrival permutations + boundary and mutation probes |
| `notFollowedBy` | Forbidden b strictly after anchor and up to inclusive deadline prevents match; fire only when deadline + lateness is reached | `test/pattern-v2-negation-oracle.test.mjs`; 250 seeds × arrivals × clock boundaries |
| Evolving late ingress to `notFollowedBy` | An event delivered later but timestamped inside the forbidden interval cancels pending absence; recomputation with a changed corpus after previous finality may retract a match, so durable finality requires a host watermark/late-evidence policy | `test/pattern-v2-evolving-negative-ingress-oracle.test.mjs`; 80 deterministic seeds × 3 permutations × pre/post-finality clocks, inclusive deadline +1ms controls |
| DST offset transitions for `notFollowedBy` | Explicit offset timestamps on Europe/Rome 2026 spring/fall transitions order by absolute instant (including repeated autumn 02:00 hour); pending until deadline + lateness, forbidden on inclusive deadline | `test/pattern-v2-dst-negative-oracle.test.mjs`; 2 transitions × 4 source scenarios × 2 exact clock boundaries × 3 delivery permutations, plus local-time mutation controls |
| `repeat(event(x))` | For `min:1..3`, `max: min..3`, enumerate valid source subsets; `combinations` allows gaps, `relaxed` skips only unrelated noise, `consecutive` requires adjacent source positions; both `greedy` and `lazy` produce the same untruncated match **set** | `test/pattern-v2-repeat-oracle.test.mjs`; 250 seeds × 3 shuffles × 2 modes × 18 exhaustive min/max/contiguity configurations |
| Execution budgets and interpretation | A bounded intermediate candidate branch can lose a real match yet return zero matches; `truncated:true` means **inconclusive**, not no-match. Temporal pending and capped semantic calls have distinct evidence | `test/pattern-v2-budget-evidence.test.mjs`; `scripts/evidence/pattern-v2-budget-evidence.mjs` |
| Candidate and semantic budgets | Budget exhaustion sets `truncated:true` even when `matches:[]`; only an untruncated empty result is a conclusive no-match within the modeled bounded snapshot | `test/pattern-v2-budget-outcomes.test.mjs`, `scripts/evidence/pattern-v2-conformance.mjs` |
| Nested budget completeness | `window(allOf(a,b))` and `window(repeat(x,2..3))` can hide a real match behind intermediate candidate truncation; exhausted runs retain `truncated:true`, while independently enumerated high-cap runs recover the exact match | `test/pattern-v2-nested-budget-completeness.test.mjs`; Cartesian pairs, finite subsets, opposite delivery orders, low-vs-high cap |
| `optional` / `repeat` candidate-cap completeness | Both branches must propagate `dedupe(...).truncated` to the evaluation-level `truncated` diagnostic; low cap=1 may suppress optional members even inside nested sequences | `test/pattern-v2-optional-repeat-truncation.test.mjs`; greedy/lazy, arrival reversal, nested sequence and repeat low/high caps |
| Incremental `allOf` candidate cap | Joins consume candidate pairs only until the first `maxCandidates + 1` **unique** Cartesian witness, preserving first-match order and explicit `truncated:true`; no full `allOf` product materialization | `test/pattern-v2-allof-streaming-cap.test.mjs`; deterministic 3×3 pair parity and measured witness-access fanout |
| Incremental `sequence` join cap | For `next`, `followedBy`, and `followedByAny`, preserve compatible-candidate order and deduplicate while generating; stop after one additional distinct completion beyond `maxCandidates` and set `truncated:true` | `test/pattern-v2-sequence-streaming-cap.test.mjs`; exact first-prefix/high-cap results, partial-empty safety witness, two arrival orders, bounded 24×24 fan-out |
| Bounded `event` source candidate generation | Every `event(ref)` node emits at most `maxCandidates` unique physical event identities before downstream filters; additional unique sources set `truncated:true` even if downstream filtering produces zero matches | `test/pattern-v2-event-candidate-cap.test.mjs`; large source fanout, calendar-filtered late match and replay duplicates |
| Negative branches under candidate truncation | `notNext` and `notFollowedBy` suppress output entirely when candidate evidence is incomplete; `truncated:true` alone is not safe because the host may persist matches | `test/pattern-v2-event-candidate-cap.test.mjs`; hidden blocker and genuine no-blocker controls at low/high caps |
| Semantic evaluation | Runs only when explicitly configured and respects bounded call count | `test/pattern-v2-semantic-cache.test.mjs`, `test/semantic-scope-budget-conformance.test.mjs` |
| Cached semantic decisions vs call cap | The cap bounds **new evaluator calls**, not valid exact-cache hits; a zero-call budget can resolve cached candidates without truncation, whereas any uncached candidate makes the result explicitly incomplete | `test/pattern-v2-semantic-cache-budget-order.test.mjs`; complete cache, missing cache, partial cache and tenant-key isolation |
| Nested semantic failure-state behavior | For `semantic(window(allOf(issue,mail)))`, exact thresholds and uncertain policy are explicit; missing evaluator defaults to a thrown error, configured `onUnavailable:reject` opts into a no-match, provider errors/invalid probabilities/timeouts reject evaluation instead of returning a complete negative; timed-out decisions never enter durable cache | `test/pattern-v2-semantic-failure-matrix.test.mjs`; two arrival permutations, policy cases, boundary scores, timeout, failure/retry, cache and structurally impossible pair controls |

## Semantic budget compatibility decision (2026-10-14)

Behavioral **correction** in Pattern AST v2, no schema or package export change:
`maxSemanticEvaluations` is the maximum number of **fresh evaluator calls**
per evaluation. A validated durable decision is reusable even when the
remaining call budget is zero. Previously, the budget check ran before the
cache lookup and returned `truncated: true` for fully cached candidates.
This is deliberately changed to `truncated: false` when **all** results
are resolved by cache. Any uncached candidate with exhausted budget still
sets `truncated: true` to prevent silent false negatives, but the scan
continues to preserve subsequent valid cache hits regardless of arrival
order. Cache
namespaces/evaluator identities continue isolating tenants and revisions.

**Migration decision:** no persisted-state rewrite is needed; the cache
key and serialized decision format are unchanged. Consumers must already
honor the `truncated` field and must not equate an incomplete zero-match
result with a complete negative finding. Behavioral release notes should
identify the changed completeness result under a warm cache. This is not
proof of arbitrary semantic failure modes or high-cardinality execution.

## Bounded semantic failure-state acceptance (2026-10-14)

`node --test test/pattern-v2-semantic-failure-matrix.test.mjs` exercises
a finite `semantic(window(allOf(issue,mail)))` fixture. Thresholds
`matchThreshold=0.8` and `rejectThreshold=0.2` classify scores at
the exact boundaries, with `uncertain` explicitly controlled by
`escalate`, `match`, or `reject`. When semantic evaluation is required:
missing evaluator under `onUnavailable:'error'`, provider exceptions,
non-finite/out-of-range probabilities, and deadline expiry **reject the
evaluation** (promise rejects) rather than emitting `matches:[]` with
`truncated:false`. Hosts must surface these failures rather than
converting them into definitive no-match. The documented
`onUnavailable:'reject'` is an **explicit opt-in** to rejecting matches
when *no evaluator is configured*, not an implicit fallback for provider
failures/timeouts. Timeout does not write a durable semantic decision;
retry can obtain a real decision. The synthetic model performs no
external network calls.

Scope: these tests do not establish scheduler delivery retries, externally
cancellable evaluator work, live provider latency guarantees, arbitrary
nested AST behavior, or all possible hostile cache implementations.

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
Invoking the evidence script directly does not clean or rebuild the workspace. The POSIX npm launcher now runs the report as `env -u NODE_OPTIONS node ...`, clearing inherited preload/loader flags **outside the attested child process**, before any Node module evaluation. The runner also rejects non-empty `process.execArgv` and any remaining `NODE_OPTIONS`. This evidence command requires the POSIX `env -u` utility (Linux/macOS/CI); a Windows shell needs an equivalent external environment-clearing launcher. It does not attest a malicious local npm process, modified Node binary, privileged host or operating system. The report includes package
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

## DST differential witness (2026-10-14)

`node --test test/pattern-v2-dst-negative-oracle.test.mjs` exercises
explicit-offset 2026 Europe/Rome spring-forward and fall-back fixtures.
Two physically adjacent occurrences are 500 ms apart despite a one-hour
wall-clock discontinuity. A tiny existing independent `notFollowedBy`
reference oracle checks exact source IDs at deadline + allowed lateness
minus one millisecond and at finality, across absence, crossing, inclusive
forbidden deadline, and deadline+1ms scenarios. Three delivery permutations
and a deliberately incorrect local-hour calculation establish sensitivity
to absolute event-time ordering; offset-free timestamp inputs are outside
the finite oracle domain and rejected. This is a **bounded synthetic UTC
offset test**, not validation of the full IANA timezone database, future
timezone rule changes, arbitrary nested Patterns, persistence or scheduling.
#44 remains open.

## Nested allOf window differential witness (2026-10-14)

`node --test test/pattern-v2-window-allof-oracle.test.mjs` checks a
separately written finite Cartesian model across six supported window
types, 100 seeded source corpora, three delivery permutations, explicit
accepted/rejected candidate pair provenance and a mutation-sensitive
inclusive time boundary. Sources deliberately use IDs ordered differently
from their event timestamps. This tests only **one-level nested**
`window(allOf(event(a),event(b)))`: it does not prove arbitrary nested
window/repeat/optional combinations, late arrivals, session grouping with
more than two bound events, persisted state or high-cardinality workloads.

## Late ingress vs frozen-corpus finality (2026-10-14)

`node --test test/pattern-v2-evolving-negative-ingress-oracle.test.mjs`
compares the actual evaluator with the independent bounded negative-window
oracle while progressively adding event-time evidence. It proves that a
forbidden event which is **delivered late** but occurred within the
negative window cancels a pending absence before finality, and that an
event with `occurredAt` just **after** the inclusive deadline does not.
It also deliberately demonstrates an important limitation: recomputing
the pure evaluator with a *different corpus* after it previously returned
a finalized absence may retract that match. This is **not** a promise of
monotonic terminal results across arbitrary future late arrivals. Durable
watermarks and deduplication/late-event disposition must be enforced and
tested at the host/store boundary before treating a negative match as
irreversible external authorization. The independent monotonicity witness
`test/pattern-v2-finality-monotonic-oracle.test.mjs` addresses only a
**frozen input corpus**.

The seeded corpus is finite, synthetic, unpartitioned, with no multi-worker
scheduler, PostgreSQL or live external producer. Parent #44 remains open.

## Bounded event candidate generation (2026-10-15)

The `event` node now creates at most `maxCandidates` **unique physical
source candidates** per evaluation and checks one extra distinct event to
set `truncated:true`. The physical replay identity is checked **before**
building any candidate, preventing repeated transient candidate allocations
for duplicate deliveries. Previously, even root `event` patterns generated
an unbounded candidate array before deduplication. This conservative
cap also protects later `calendar` or other filters: if a valid match
appears after the cap, the result may be empty but **cannot** be interpreted
as a complete no-match because `truncated:true` remains set. Repeated
copies of the same physical event identity do not consume distinct slots.

**Negation safety:** a truncated forbidden pattern in `notNext` or
`notFollowedBy` could omit the blocker and cause a false negative-pattern
match. Because the composite host may persist matches even with
`truncated:true`, these operators now fail closed when candidate
evaluation is incomplete: `matches:[]`, `pending:[]`,
`truncated:true`, not a best-effort negative match. When forbidden
evidence is complete, true negative matches remain available.
`test/pattern-v2-event-candidate-cap.test.mjs` exercises hidden
blockers and true negative controls under both operators.

This limits candidate-object creation after input sorting; it is not
an input/stream buffer size cap or a universal CPU/memory budget.
The change can mark previously exhaustive post-filter evaluations
incomplete when the source exceeds the cap; this is an intentional
correctness guarantee, with no AST/schema/persistence migration.

## Incremental sequence completion bound (2026-10-15)

`sequence` now collects only the first `maxCandidates` distinct merged
completions in their existing `next`, `followedBy`, or `followedByAny`
preference/order, and stops on the first additional distinct completion
with `truncated:true`. Earlier, all compatible merged pairs were materialized
before a final deduplication cap. The regression tests verify low/high-cap
prefix equivalence, `followedBy` first-successor selection and `next`
false-negative incompleteness, plus a finite 24×24 fan-out source-access
witness. This bounds retained *merged completions*; per-left compatible
successor sorting and evaluator input sorting remain separate resource
costs. It is not a global memory/CPU guarantee or a new AST version.

## Incremental allOf join cap (2026-10-15)

`allOf` now deduplicates and retains candidate combinations **during**
Cartesian traversal; it stops after discovering the first additional unique
candidate beyond `maxCandidates`. Previously, the full product was
materialized before the cap, exposing evaluation to excessive peak
intermediate memory and CPU. The first retained witnesses, chronological
candidate ordering, and the explicit `truncated` outcome are preserved.
The regression compares exact Cartesian-source pair identity at high cap
and its first capped prefix in two arrival orders; a measured-access
probe verifies that small caps no longer process the complete 32×32
fanout.

This is a focused **work/peak-memory hardening** of `allOf`, not a
universal evaluator budget: standalone `event` expansion, `sequence`,
`repeat` and other composed operators still require their own caps.
No persisted-data or AST migration is needed. The observable semantics
remain bounded candidate results plus `truncated:true` when there are
additional unique candidate combinations.

## Optional/repeat completeness correction (2026-10-15)

The canonical v2 evaluator formerly returned only
`dedupe(...).values` in `optional` and `repeat` without forwarding the
deduplicator's truncation state. In particular, an optional branch with
`maxCandidates=1` could silently drop real event candidates while reporting
`truncated:false`. The correction propagates these flags without changing
the AST, selection policy or persisted state; callers must already treat
`truncated:true` as incomplete. The regression fixture exercises
greedy/lazy options, changed delivery order, nested sequences and repeat
with low/high caps. The `repeat` traversal stops only on its **own**
enumeration cap, not merely because a nested optional child recorded a
truncation; valid retained nonempty child units still produce all reachable
combinations within the repeat's local limit. No data migration is required; the deliberately
changed result is the completeness diagnostic for budget-limited runs.

## Nested candidate-completeness safety witness (2026-10-14)

`node --test test/pattern-v2-nested-budget-completeness.test.mjs`
constructs finite nested `window(allOf(a,b))` and
`window(repeat(event(x)))` programs whose only valid match lies after
many invalid intermediate candidates. Independent pair/subset enumeration
checks a single matching source pair. The low-cap evaluation deliberately
loses the match but **must report `truncated:true`**; a higher cap must
recover the exact match with `truncated:false`. Two arrival orders guard
against processing-order-dependent completeness assertions.

This proves a bounded synthetic subset only; it is not a performance
benchmark or a universal proof for all AST compositions, streaming
selection/late events, high-cardinality PostgreSQL or multi-worker runtime.
Host interpretation of `truncated` remains mandatory and the parent #44
still requires expanded adversarial/mutation and operational evidence.

## Production evaluator mutation gate (2026-10-15)

The CI/release gate now runs **real modified compiled evaluator modules**,
not mocked functions or mutated reference-oracle expectations:
`node scripts/evidence/cep-production-mutation-report.mjs --out
cep-production-mutation-evidence.json`. The file is archived as
`cep-production-mutation-evidence` in CI and as
`public-release-cep-mutation-evidence` on public release-check pushes.
The normal `npm run check` also runs the same mutation-kill assertions.

Three deliberately seeded compiled-JavaScript mutations must produce
a different result from the independent finite witness specification:
1. `event_dropped_truncation`: dropping the event-cap incompleteness flag
   while retaining only the capped source prefix;
2. `allof_dropped_truncation`: not propagating join-budget truncation;
3. `negative_forbidden_deadline_exclusive`: changing inclusive forbidden
   deadline to exclusive.

Each mutation is evaluated over 16 deterministic arrival permutations
with seed `20261015`. The report binds the compiled evaluator SHA-256,
mutant source SHA-256, fixture hashes, seed, exact expected projection,
and a witnessed wrong result. Mutants **must import and evaluate
successfully**; a syntax error or crashed evaluator is not accepted as
a killed semantic mutation. Temporary snapshot modules are deleted in
`finally`. The gate fails on a surviving mutant or changed mutation
anchor, preventing silent drift of the regression claims.

**Scope:** This is a **three-mutant targeted proof**, not a mutation score
for the whole engine, randomized falsification of all 22 AST nodes,
coverage of nested temporal/selection states, or a full resource bound.
The working Node/OS, repository and test dependencies are trusted. The
fixture events are synthetic only; this script must not be extended to
emit live private source events. Parent #44 remains open until
expanded composition/fuzz/release evidence and remaining resource
invariants have been validated.

## Equal-timestamp ordering and extreme ISO date witness (2026-10-15)

`test/pattern-v2-equal-time-ordering-oracle.test.mjs` compares
`sequence(next)` to an independent finite adjacency oracle ordered by
(1) absolute `occurredAt` instant, (2) `sourceEventId`, then
(3) `clauseId`. All 96 seeded fixtures deliberately include simultaneous
occurrences and three arrival permutations. A separate witness exercises
the third tie-break rule with identical source IDs owned by **different
servers**, plus UTC-offset-equivalent timestamps and valid ISO years 0001
and 9999. The comparator is a *specified* part of the current canonical
evaluator contract; this finite test is not a universal proof for
duplicate physical provider event IDs, very large input arrays,
process-specific locales or all calendar/timezone implementations.

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
