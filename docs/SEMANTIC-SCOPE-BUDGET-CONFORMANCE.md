# Semantic evaluation contract: bounded synthetic checks

Tracking roadmap issue 49. This test suite exercises the existing Pattern
AST v2 semantic node. It does not introduce another language or agent loop.

- Up to two semantic evaluations across six candidates; exhaustion must
  report truncation instead of a normal no-match.
- Cache reuse is scoped to the host-supplied namespace, evaluator identity
  and trigger revision. Revisions and scopes must be distinct.
- Unavailable evaluator with an explicit reject fallback yields no
  invented semantic result; structural event matching works normally.

Run: `node --test test/semantic-scope-budget-conformance.test.mjs`
after `npm run build`.

The corpus is synthetic, without human-labeled quality measurements.
This does not cover TTL, cost/token budgets across batches, notification
deduplication or real-world semantic relevance. Hosts must supply properly
tenant-scoped namespaces and authoritative storage.
