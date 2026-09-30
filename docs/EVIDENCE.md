# Pattern AST evidence harness

Event Intelligence v0.6 includes a reproducible evidence harness for **correctness** and **performance characterization**. It produces machine-readable JSON that can be archived and compared across commits, Node versions and storage/runtime changes.

## Quick evidence

```bash
npm run evidence:pattern-v2
```

The script builds the package, runs deterministic conformance/property checks and executes the quick benchmark profile. The script name keeps the wire-schema version visible; the runtime itself has one Pattern architecture.

## Conformance

```bash
npm run conformance:pattern-v2
```

The current corpus verifies:

- delivery-order invariance where event-time semantics require it;
- bounded candidate growth under combinatorial repeat;
- allowed-lateness behavior for bounded negative patterns;
- explicit and budgeted semantic evaluation.

The normal test suite remains the authoritative regression suite. This command is a compact shareable checkpoint for the Pattern evaluator.

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

The benchmark reports p50/p95/p99/max/mean evaluation latency, evaluated-event throughput, memory deltas, emitted matches and candidate-budget truncation.

Included scenarios cover both ordinary and adversarial shapes:

- ordered sequence;
- aggregate + bounded count window;
- combinatorial repeat with a hard candidate budget.

## Interpretation

Do not compare an in-process quick run directly with Flink/Esper cluster throughput. EI is currently an embedded agent CEP runtime. Meaningful external comparisons must publish hardware, Node version, scenario definitions, event cardinality, partitioning and storage mode.

Remaining evidence work includes:

- full-engine partition benchmarks at 1k/10k/100k durable triggers;
- shared-store / multi-worker results once a production transactional backend lands;
- crash/restart and replay chaos runs;
- semantic-cache cost/hit-rate characterization;
- archived benchmark baselines for release commits.
