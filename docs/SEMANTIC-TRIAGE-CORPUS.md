# Synthetic semantic triage evaluation corpus — #49 (partial)

Run after building:

```sh
npm run build
node scripts/evidence/semantic-triage-corpus.mjs > semantic-triage-corpus.json
node --test test/semantic-triage-synthetic-corpus.test.mjs
```

The versioned `ei.semantic-triage-corpus.v1` report contains fourteen
**fictional** GitHub issue/PR change scenarios with author-provided
important/not-important labels and separately assigned scripted probabilities.
It runs through the **real Pattern AST v2 semantic evaluation path** with a
vendor-neutral mock evaluator, two match thresholds (high-precision and
balanced), a finite candidate budget and a deterministic structural event
prefilter. It does not wake any runtime or run an always-on agent.

The report preserves all per-case decisions, confusion matrix,
precision/recall, counted evaluator calls and approximate fixture tokens per
notification. The token numbers are **input assumptions in the corpus**, not
measured model consumption, provider billing or an economically calibrated
cost estimate. The scripted evaluator is **not** a validated AI model and
cannot demonstrate real-world importance detection. A model-free P0 release
may omit this P2 feature.

Further #49 work: labeled real-redacted corpus and independent annotation;
host-selected token/monetary ceilings across a batch and restart, durable
versioned evaluation context, semantic dedup/debounce and measured latency;
cross-tenant cost budget enforcement; model evaluator/timeouts/retry quality
tradeoffs. These remain unproven. No provider secrets, approval policy or
model dependency is added to EI.
