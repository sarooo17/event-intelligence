# Pattern AST v2 evidence harness

Event Intelligence v0.5 has a reproducible evidence harness for **correctness** and **performance characterization**. The harness is intentionally separate from marketing claims: it produces machine-readable JSON that can be archived and compared across commits, Node versions and storage/runtime changes.

## Quick evidence

```bash
npm run evidence:pattern-v2
```

This builds the package, runs deterministic conformance/property checks and then executes the quick benchmark profile.

## Conformance

```bash
npm run conformance:pattern-v2
```

The current corpus verifies:

- delivery-order invariance where event-time semantics require it;
- bounded candidate growth under combinatorial repeat;
- allowed-lateness behavior for bounded negative patterns;
- explicit/budgeted semantic evaluation;
- representative legacy-to-v2 compilation.

The normal test suite remains the authoritative regression suite. This command is a compact, shareable conformance checkpoint.

## Benchmarks

Quick profile:

```bash
npm run bench:pattern-v2
```

Full profile:

```bash
npm run build
node scripts/evidence/pattern-v2-benchmark.mjs --profile full
```

Override workload size:

```bash
node scripts/evidence/pattern-v2-benchmark.mjs \
  --profile full \
  --events 100000 \
  --iterations 10
```

The benchmark reports p50/p95/p99/max/mean evaluation latency, evaluated-event throughput, memory deltas, emitted matches and whether candidate budgets truncated an evaluation.

The included scenarios deliberately cover both ordinary and adversarial shapes:

- ordered sequence;
- aggregate + bounded count window;
- combinatorial repeat with a hard candidate budget.

## Interpretation

Do not compare a quick local run directly with Flink/Esper cluster throughput. Pattern AST v2 is currently an embedded agent CEP runtime, and this harness measures the EI evaluator in-process. Meaningful external comparisons must publish hardware, Node version, scenario definitions, event cardinality, partitioning and storage mode.

Future evidence should add:

- full-engine partition benchmarks at 1k/10k/100k durable triggers;
- shared-store / multi-worker results once the async shared-state store contract lands;
- crash/restart and replay chaos runs;
- semantic cache cost/hit-rate characterization;
- archived benchmark baselines for release commits.
