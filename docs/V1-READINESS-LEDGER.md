# v1.0 evidence ledger and release eligibility (issue #50)

The checked-in `docs/releases/v1-readiness.json` is the explicit list
of **eleven required stable-v1 criteria** which remain **blocking** and
one optional, owner-waived independent-host-authorship criterion.
The 2026-10-30 product-owner decision in #41 makes **both #48 and #49
required for stable 1.0.0**, although hosts may omit semantic models at
runtime. Security signoff is tracked by #317 alongside #45. Every row
maps to its numbered issue. All rows start as `blocked` because the repo does not have
independently reviewed evidence for full v1 acceptance yet.

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
Production/HA capacity remains explicitly unverified until actual
1k/10k/100k benchmarking, fault-soak, independent host adoption, security
signoff and restore policy acceptance.

**Scope regression guard:** `test/v1-release-readiness-ledger.test.mjs`
refuses manifests that downgrade #48 or #49 to optional, and proves both
remaining blocked rows prevent eligibility even if all other required rows
carry formally valid manual reviewer records. This gate change does not
claim #48/#49 completion or authorize automatic publishing.
