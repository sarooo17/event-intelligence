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
Every row must remain `blocked` **until** release-specific evidence is reviewed
and a named, source-pinned attestation is merged; an implementation issue
marked completed never auto-verifies a ledger row.

**Published release — 2026-11-11:** `mcp-event-intelligence@1.0.0` was published to npm `latest` by the [successful manual publish workflow](https://github.com/sarooo17/event-intelligence/actions/runs/43035988681). The [Release workflow](https://github.com/sarooo17/event-intelligence/actions/runs/43036379159) published the official MCP Registry `io.github.sarooo17/event-intelligence@1.0.0` and [GitHub tag/release `v1.0.0`](https://github.com/sarooo17/event-intelligence/releases/tag/v1.0.0) from exact commit `f15c8c5e6ffab55d5a3fddefee2c64d3738be68d`.

The immutable tagged release preserved **9/9 source-pinned required bounded SDK attestations** from [PR #421](https://github.com/sarooo17/event-intelligence/pull/421), which followed the documentation refresh in [PR #420](https://github.com/sarooo17/event-intelligence/pull/420). Evidence reviewers were **owner-delegated GPT-6 technical/evidence reviewers, NOT independent human host-security auditors**. The six **optional production/enterprise** criteria remain `blocked`; [#317](https://github.com/sarooo17/event-intelligence/issues/317) and [#376](https://github.com/sarooo17/event-intelligence/issues/376) track those separate assurances.

**Post-release `main` is a different source identity from the immutable v1.0.0 artifact.** If documentation or code changes after this release, temporarily block the nine source-bound attestations, merge and review the updated source, then reattest in a **separate ledger-only PR** before any future `--strict` release-gate use. This **does not revoke the historical 9/9 reviewed, already-published `v1.0.0` release**. Do not weaken `--review-attestations`, manufacture human certification or attempt to republish the same immutable npm version.

The 2026-11-02 npm screenshot of `0.11.0` (`latest`) / `0.12.0-next.1` (`next`) is historical and superseded by the 2026-11-11 release. Use the [current published v1.0.0 compatibility matrix](releases/1.0.0-compatibility.md) for installation and operator migration.

```sh
# Read-only report: expected 9/9 -> eligible-for-manual-review only
# after the source-pinned attestations have been revalidated on main.
node scripts/evidence/v1-release-readiness.mjs --report

# Source-pinned strict preflight (NOT a publish command). Requires all
# nine signed gates, reviewed main ancestor, zero post-review source drift,
# exact checked-out HEAD and canonical 1.0.0 version.
EI_RELEASE_SOURCE_SHA="$(git rev-parse HEAD)" \
  node scripts/evidence/v1-release-readiness.mjs --strict
```

The Public Release Check captures the `--report` JSON as an
artifact for the inspected source; after correct 9/9 signoff the
status may read `eligible-for-manual-review`. It does **not** automatically
publish, tag, merge or update consumer pins; only the separately authorized
operator workflow runs `--strict` before writing to npm. The checker validates the exact criteria set, no duplicates,
current product-owner required/optional classification, status, and manually authored signoff/evidence
metadata for any `verified` row. It does not fetch GitHub live state or
assert an external security review from its own contents: claims are
subject to human/reviewer verification, and `autoPublish` is always false.

Before changing a row to `verified`, the release owner must attach evidence
links, named reviewer, date and explicit verification procedure; PR review
must verify both completeness and truth of those artifacts. For stable v1, a
verified row must also contain an immutable 40-character
`verification.sourceCommitSha` pointing to a **previously reviewed, frozen
main-branch source commit**. The strict publish/release check verifies that
this commit is an ancestor of the actual release HEAD and that the entire
repo, except this readiness ledger, has no changes since the reviewed source.
It is impossible for a committed file to contain its own commit hash; do not
ask the ledger to sign itself. `--strict` also requires
`EI_RELEASE_SOURCE_SHA` set to the actual checked-out HEAD and is blocked
until package identity is exactly `1.0.0`. Workflow runs derive this from
GitHub and recheck the Git commit; neither `--report` nor a user-written
reviewer string is independent evidence. A green
`eligible-for-manual-review` means only all checked-in prerequisites are
declared, not that an npm publish is safe or authorized. Existing exact
Muffin/Artemis dependency pins are never touched by this workflow.

Compatibility: this ledger checker is an internal operator tool, not a runtime/API change, database migration or publication action. Its source/CI report does not itself publish or attest any npm version.
Published 1k/10k/100k isolated PostgreSQL16 benchmarks and crash recovery
tests are SDK engineering evidence, not production claims. Independently
operated host adoption, full real-source finality, provider-billed spend,
production PostgreSQL primary failover RPO/RTO, p99 latency and human security
attestation remain open under #376/#317. **Do not advertise any of these as
certified**, even though the nine generic SDK gates have been verified.

**Scope regression guard:** `test/v1-release-readiness-ledger.test.mjs`
refuses downgrading the nine core SDK requirements (including #48 and #49),
rejects promotion of external certification rows as mandatory without an
explicit policy change, and confirms that optional external reports cannot
bypass core retention/security gates. The checker never auto-publishes.
