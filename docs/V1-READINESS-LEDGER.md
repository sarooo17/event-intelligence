# v1.0 evidence ledger and release eligibility (issue #50)

The checked-in `docs/releases/v1-readiness.json` is the explicit list
of **nine mandatory SDK correctness criteria** and **six optional
production/integration certification criteria**. Optional means not a
prerequisite to publishing the generic SDK, **not** verified or unnecessary.
The explicit 2026-10-31 product-owner scope correction (#41) keeps both
**#48 explainability and #49 optional-at-runtime semantics mandatory as
bounded SDK contracts**. Their external provider truth/billing obligations
are tracked under the **optional operational validation #376** instead.
#45 mandatory security is SDK authorization/fail-closed reference behavior;
#317 human-operated external-host security certification is separate and
optional for the generic SDK. Real PostgreSQL16 correctness and defensible
retention/recovery remain mandatory. Every row maps to its numbered issue.
Every row remains `blocked` until release-specific manually reviewed evidence
is attached; an issue marked completed does not auto-verify its ledger row.

```sh
# Report only: validates manifest and emits a machine-readable blocked state.
node scripts/evidence/v1-release-readiness.mjs --report

# Strict operator preflight: returns a nonzero exit until all required evidence
# is recorded and the package manifest itself says 1.0.0.
node scripts/evidence/v1-release-readiness.mjs --strict
```

The Public Release Check workflow captures the `--report` JSON as an
artifact while the package is still pre-v1. It intentionally does **not**
auto-publish, tag, merge, update consumer pins or turn the strict gate on
prematurely. The checker validates the exact criteria set, no duplicates,
current product-owner required/optional classification, status, and manually authored signoff/evidence
metadata for any `verified` row. It does not fetch GitHub live state or
assert an external security review from its own contents: claims are
subject to human/reviewer verification, and `autoPublish` is always false.

Before changing a row to `verified`, the release owner must attach evidence
links, named reviewer, date and explicit verification procedure; PR review
must verify both completeness and truth of those artifacts. A green
`eligible-for-manual-review` means only all checked-in prerequisites are
declared, not that an npm publish is safe or authorized. Existing exact
Muffin/Artemis dependency pins are never touched by this workflow.

Compatibility: this is an additive internal operator tool, no runtime or
public package API change, no data migration and no published release.
Published 1k/10k/100k isolated PostgreSQL16 benchmarks and crash recovery
tests are SDK engineering evidence, not production claims. Independently
operated host adoption, full real-source finality, provider-billed spend,
production PostgreSQL primary failover RPO/RTO, p99 latency and human security
attestation remain open under #376/#317. **Do not advertise any of these as
certified**, even when a generic SDK release gate is later eligible.

**Scope regression guard:** `test/v1-release-readiness-ledger.test.mjs`
refuses downgrading the nine core SDK requirements (including #48 and #49),
rejects promotion of external certification rows as mandatory without an
explicit policy change, and confirms that optional external reports cannot
bypass core retention/security gates. The checker never auto-publishes.
