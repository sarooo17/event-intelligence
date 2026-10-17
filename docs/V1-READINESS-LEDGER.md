# v1.0 evidence ledger and release eligibility (issue #50)

The checked-in `docs/releases/v1-readiness.json` is the explicit list
of ten P0 requirements which remain **blocking** and two optional P1/P2
workstreams. Every requirement maps to its GitHub parent issue (#42, #45,
#47 or #50). All rows start as `blocked` because the repo does not have
independently reviewed evidence for full v1 acceptance yet.

```sh
# Report only: validates manifest and emits a machine-readable blocked state.
node scripts/evidence/v1-release-readiness.mjs --report

# Strict operator preflight: returns a nonzero exit until all P0 evidence
# is recorded and the package manifest itself says 1.0.0.
node scripts/evidence/v1-release-readiness.mjs --strict
```

The Public Release Check workflow captures the `--report` JSON as an
artifact while the package is still pre-v1. It intentionally does **not**
auto-publish, tag, merge, update consumer pins or turn the strict gate on
prematurely. The checker validates the exact criteria set, no duplicates,
P0/P1/P2 classification, status, and manually authored signoff/evidence
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
