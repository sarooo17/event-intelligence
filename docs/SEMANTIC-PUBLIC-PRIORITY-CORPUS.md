# Reproducible real-redacted public issue priority proxy corpus

**Source:** 40 real, public GitHub **issues (not PRs)** from
`kubernetes/kubernetes`, queried on 2026-10-29 using the GitHub Issues
search endpoint, filtering separately by maintainer-assigned
`priority/critical-urgent` and `priority/backlog`. This is a pinned
balanced 20/20 snapshot with explicit source issue URLs and creation dates
in `scripts/evidence/semantic-real-redacted-fixtures.mjs`.

Source queries:

- `repo:kubernetes/kubernetes is:issue label:priority/critical-urgent`
- `repo:kubernetes/kubernetes is:issue label:priority/backlog`

The label came from **independent upstream maintainers**, not the
evaluator; no label is passed in the candidate event payload or in the
semantic evaluator's input. The source repository can change label
assignments later, so the snapshot preserves the label observed on
2026-10-29; CI intentionally never refetches external data.

Only truncated (200-character) normalized issue titles are snapshotted.
URL, email, account mention, literal IP, machine-home path and unusually
long hash-like spans are replaced with placeholders. **No issue bodies,
authors, comments, private provider tokens or user account data.** The
original issues are public; this is data minimization rather than
irreversible anonymization.

Run:

```sh
npm run build
node scripts/evidence/semantic-real-redacted-corpus.mjs
node --test test/semantic-real-redacted-corpus.test.mjs
```

Two fixed thresholds (`0.85` high-precision and `0.55` balanced)
are evaluated through the real canonical Pattern v2 semantic node,
using a transparent **deterministic lexical baseline**, not any
commercial LLM. Each reports TP, FP, TN, FN, precision, recall,
false-negative rate, notifications, estimated upper-bound input tokens
and hypothetical micro-dollar cost-per-notification based on an
**assumed** $3/million input tokens. These costs are scenario estimates,
not actual model token reports, provider bills or production spending.

**Interpretation and limitations:** An externally maintained issue
priority label is a reproducible *proxy* for a desirable alert, not a
directly observed, independent user's notification relevance judgment.
The sample is nonrandom, temporally concentrated, balanced rather than
workload-distributed, and drawn from one public infrastructure project.
The lexical baseline cannot predict actual AI-model performance.
This supplies distinct real-redacted, independently labeled evidence
and explicit reproducible tradeoffs alongside the existing 14 fictional
synthetic cases. A provider-model quality/reliability claim requires
real model scores, repeated independent labeling and a representative
holdout distribution.

All label and cost claims in issues/README should retain this
qualification. No provider SDK or always-on agent is required to run
the experiment.
